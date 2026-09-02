import { load } from "cheerio";
import { AppError } from "../errors.ts";
import { cleanText, fetchWithRetry } from "../http.ts";
import { StartRateLimiter } from "../rate-limit.ts";
import type { BookIdentifier, MetadataProvider, ProviderRecord } from "../types.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let amazonDisabledReason: string | undefined;
const limiter = new StartRateLimiter();

function jitter(): number {
  return 500 + Math.floor(Math.random() * 1001);
}

function parseDynamicImage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const entries = Object.keys(JSON.parse(value) as Record<string, unknown>);
    return entries[0];
  } catch {
    return undefined;
  }
}

function detailValue(details: Map<string, string>, names: string[]): string | undefined {
  for (const [key, value] of details) {
    if (names.some((name) => key.includes(name.toLowerCase()))) return value;
  }
  return undefined;
}

export class AmazonProvider implements MetadataProvider {
  readonly name = "amazon" as const;

  constructor(
    private readonly domain = "com",
    private readonly cookie?: string,
  ) {}

  private async get(path: string): Promise<string> {
    if (amazonDisabledReason) throw new AppError("amazon_disabled", amazonDisabledReason);
    return limiter.run(jitter(), () => this.getNow(path));
  }

  private async getNow(path: string): Promise<string> {
    if (amazonDisabledReason) throw new AppError("amazon_disabled", amazonDisabledReason);
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.8",
    });
    if (this.cookie) headers.set("Cookie", this.cookie);
    try {
      const response = await fetchWithRetry(`https://www.amazon.${this.domain}${path}`, {
        headers,
        retries: 0,
        timeoutMs: 20_000,
      });
      const html = await response.text();
      if (/captcha|robot check|enter the characters you see below/i.test(html)) {
        amazonDisabledReason = "Amazon returned a CAPTCHA/robot check; Amazon was disabled for this run.";
        throw new AppError("amazon_blocked", amazonDisabledReason);
      }
      return html;
    } catch (error) {
      if (error instanceof AppError && /returned 50[03]/.test(error.message)) {
        amazonDisabledReason = "Amazon returned an anti-automation server response; Amazon was disabled for this run.";
        throw new AppError("amazon_blocked", amazonDisabledReason, error);
      }
      throw error;
    }
  }

  private async findAsins(identifier: BookIdentifier): Promise<string[]> {
    if (identifier.kind === "asin") return [identifier.value];
    const html = await this.get(`/s?k=${encodeURIComponent(identifier.isbn13 ?? identifier.value)}&i=stripbooks`);
    const $ = load(html);
    const asins = new Set<string>();
    $('[data-component-type="s-search-result"][data-asin]').each((_index, node) => {
      const asin = $(node).attr("data-asin")?.toUpperCase();
      if (asin && /^[A-Z0-9]{10}$/.test(asin)) asins.add(asin);
    });
    return [...asins].slice(0, 3);
  }

  private async parseProduct(asin: string, identifier: BookIdentifier): Promise<ProviderRecord | undefined> {
    const html = await this.get(`/dp/${asin}`);
    const $ = load(html);
    const details = new Map<string, string>();
    $("#detailBullets_feature_div li, #productDetailsTable li, #productDetails_detailBullets_sections1 tr").each(
      (_index, node) => {
        const row = $(node).text().replace(/\s+/g, " ").trim();
        const separator = row.indexOf(":");
        if (separator > 0) details.set(row.slice(0, separator).trim().toLowerCase(), row.slice(separator + 1).trim());
        const heading = $(node).find("th").text().trim().toLowerCase();
        const value = $(node).find("td").text().replace(/\s+/g, " ").trim();
        if (heading && value) details.set(heading, value);
      },
    );

    const title = cleanText($("#productTitle").text());
    const authors = new Set<string>();
    $("#bylineInfo .author").each((_index, node) => {
      const byline = cleanText($(node).text());
      const roles = [...(byline?.matchAll(/\(([^)]+)\)/g) ?? [])].map((match) => match[1]!.toLowerCase());
      if (roles.length > 0 && !roles.some((role) => /\bauthor\b/.test(role))) return;
      const author = cleanText($(node).find("a").first().text());
      if (author && !/visit the|follow|more$/i.test(author)) authors.add(author);
    });
    const image =
      parseDynamicImage($("#imgBlkFront").attr("data-a-dynamic-image")) ??
      parseDynamicImage($("#landingImage").attr("data-a-dynamic-image")) ??
      $("#imgBlkFront, #landingImage").first().attr("src");
    const description = cleanText(
      $("#bookDescription_feature_div, #productDescription, #featurebullets_feature_div").first().text(),
    );
    const format = cleanText($("#tmmSwatches .a-button-selected .a-button-text").text());
    const seriesText = cleanText($("#seriesBulletWidget_feature_div, #rpi-attribute-book_details-series").text());
    const seriesMatch = seriesText?.match(/(?:Book\s+([\d.]+)\s+of\s+\d+|Part of:\s*)(.+?)(?:\s+series)?$/i);
    const pagesValue = detailValue(details, ["print length", "paperback", "hardcover"]);
    const pages = pagesValue?.match(/([\d,]+)\s+pages/i)?.[1]?.replace(/,/g, "");
    const isbn10 = detailValue(details, ["isbn-10"])?.replace(/[^\dX]/gi, "");
    const isbn13 = detailValue(details, ["isbn-13"])?.replace(/\D/g, "");
    if (
      identifier.kind !== "asin" &&
      ![isbn10, isbn13].some((value) => value === identifier.value || value === identifier.isbn13 || value === identifier.isbn10)
    ) {
      return undefined;
    }

    return {
      provider: this.name,
      matchedIdentifier: identifier.value,
      fetchedAt: new Date().toISOString(),
      sourceUrl: `https://www.amazon.${this.domain}/dp/${asin}`,
      title,
      authors: [...authors],
      description,
      publisher: detailValue(details, ["publisher"]),
      publishedDate: detailValue(details, ["publication date"]),
      language: detailValue(details, ["language"]),
      isbn10,
      isbn13,
      asin,
      format,
      pageCount: pages ? Number(pages) : undefined,
      series: seriesMatch?.[2]
        ? { name: seriesMatch[2].trim(), ...(seriesMatch[1] ? { position: seriesMatch[1] } : {}) }
        : undefined,
      covers: image ? [{ url: image, source: this.name }] : undefined,
    };
  }

  async lookup(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    const asins = await this.findAsins(identifier);
    const records: ProviderRecord[] = [];
    for (const asin of asins) {
      const record = await this.parseProduct(asin, identifier);
      if (record) records.push(record);
    }
    return records;
  }
}

export function resetAmazonRunState(): void {
  amazonDisabledReason = undefined;
  limiter.reset();
}
