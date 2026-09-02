import { AppError, errorMessage } from "./errors.ts";
import type {
  BookIdentifier,
  CoverCandidate,
  MergedBook,
  MetadataProvider,
  ProviderName,
  ProviderRecord,
} from "./types.ts";

const priorities = {
  general: ["google-books", "hardcover", "open-library", "amazon"],
  series: ["hardcover", "amazon", "open-library", "google-books"],
  edition: ["hardcover", "amazon", "google-books", "open-library"],
  cover: ["amazon", "hardcover", "google-books", "open-library"],
} satisfies Record<string, ProviderName[]>;

function ordered(records: ProviderRecord[], order: ProviderName[]): ProviderRecord[] {
  return [...records].sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
}

function firstValue<K extends keyof ProviderRecord>(
  records: ProviderRecord[],
  key: K,
  order: ProviderName[],
): { value: ProviderRecord[K]; provider: ProviderName } | undefined {
  for (const record of ordered(records, order)) {
    const value = record[key];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      return { value, provider: record.provider };
    }
  }
  return undefined;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function assertUnambiguous(records: ProviderRecord[]): void {
  for (const provider of new Set(records.map((record) => record.provider))) {
    const titles = new Set(
      records
        .filter((record) => record.provider === provider && record.title)
        .map((record) => normalizeTitle(record.title!)),
    );
    if (titles.size > 1) {
      throw new AppError("ambiguous_match", `${provider} returned multiple exact matches with different titles.`);
    }
  }
}

function selectCover(records: ProviderRecord[]): CoverCandidate | undefined {
  for (const provider of priorities.cover) {
    const candidates = records
      .filter((record) => record.provider === provider)
      .flatMap((record) => record.covers ?? [])
      .filter((cover) => /^https:\/\//i.test(cover.url))
      .sort((a, b) => (b.width ?? 0) * (b.height ?? 1) - (a.width ?? 0) * (a.height ?? 1));
    if (candidates[0]) return candidates[0];
  }
  return undefined;
}

export function mergeRecords(identifier: BookIdentifier, records: ProviderRecord[], warnings: string[] = []): MergedBook {
  if (records.length === 0) throw new AppError("not_found", `No provider returned an exact match for ${identifier.value}.`);
  assertUnambiguous(records);
  const title = firstValue(records, "title", priorities.general);
  const authors = firstValue(records, "authors", priorities.general);
  if (!title?.value || !authors?.value?.length) {
    throw new AppError("incomplete_metadata", "An exact match was found, but it did not contain both title and author.");
  }

  const provenance: Record<string, ProviderName> = { title: title.provider, authors: authors.provider };
  const result: MergedBook = {
    identifier,
    title: title.value,
    authors: authors.value,
    providers: [...new Set(records.map((record) => record.provider))],
    sources: records.flatMap((record) =>
      record.sourceUrl ? [{ provider: record.provider, url: record.sourceUrl }] : [],
    ),
    provenance,
    warnings,
  };

  const fields: Array<[keyof ProviderRecord, ProviderName[]]> = [
    ["subtitle", priorities.general],
    ["description", priorities.general],
    ["publisher", priorities.general],
    ["publishedDate", priorities.general],
    ["isbn10", priorities.general],
    ["isbn13", priorities.general],
    ["asin", priorities.general],
    ["language", priorities.general],
    ["pageCount", priorities.general],
    ["series", priorities.series],
    ["edition", priorities.edition],
    ["format", priorities.edition],
  ];
  for (const [key, order] of fields) {
    const selected = firstValue(records, key, order);
    if (selected) {
      (result as unknown as Record<string, unknown>)[key] = selected.value;
      provenance[key] = selected.provider;
    }
  }

  const categories = [...new Set(records.flatMap((record) => record.categories ?? []).map((item) => item.trim()))].filter(Boolean);
  if (categories.length) result.categories = categories;
  const ratings = records.flatMap((record) => record.ratings ?? []);
  if (ratings.length) result.ratings = ratings;
  const cover = selectCover(records);
  if (cover) {
    result.covers = [cover];
    provenance.cover = cover.source;
  }
  return result;
}

export async function lookupBook(
  identifier: BookIdentifier,
  providers: MetadataProvider[],
): Promise<MergedBook> {
  const settled = await Promise.allSettled(providers.map((provider) => provider.lookup(identifier)));
  const records: ProviderRecord[] = [];
  const warnings: string[] = [];
  settled.forEach((outcome, index) => {
    const provider = providers[index]!;
    if (outcome.status === "fulfilled") records.push(...outcome.value);
    else warnings.push(`${provider.name}: ${errorMessage(outcome.reason)}`);
  });
  try {
    return mergeRecords(identifier, records, warnings);
  } catch (error) {
    if (error instanceof AppError && warnings.length) {
      throw new AppError(error.code, `${error.message} Provider warnings: ${warnings.join(" | ")}`, error);
    }
    throw error;
  }
}
