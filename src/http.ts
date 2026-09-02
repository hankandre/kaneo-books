import { AppError } from "./errors.ts";

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  return Math.min(1000 * 2 ** attempt, 5_000);
}

function safeUrl(value: string | URL): string {
  try {
    const url = new URL(String(value));
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password/i.test(key)) url.searchParams.set(key, "[redacted]");
    }
    if (url.username || url.password) {
      url.username = "[redacted]";
      url.password = "[redacted]";
    }
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

export async function fetchWithRetry(url: string | URL, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, retries = 2, ...request } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === retries) {
        const detail = (await response.text()).slice(0, 500);
        throw new AppError("http_error", `${request.method ?? "GET"} ${safeUrl(url)} returned ${response.status}: ${detail}`);
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries || (error instanceof AppError && error.code === "http_error")) throw error;
    }
    await delay(retryDelay(response, attempt));
  }
  throw new AppError("network_error", `Request to ${safeUrl(url)} failed`, lastError);
}

export async function fetchJson<T>(url: string | URL, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(url, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new AppError("invalid_response", `Invalid JSON returned by ${safeUrl(url)}`, error);
  }
}

export function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

export function htmlToText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || undefined;
}
