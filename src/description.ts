import type { MergedBook } from "./types.ts";

function inline(value: string): string {
  return value.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim();
}

function linkLabel(value: string): string {
  return value.replace(/[\[\]]/g, "");
}

export function renderDescription(book: MergedBook, coverUrl?: string): string {
  const lines: string[] = [];
  if (coverUrl) lines.push(`![Book cover](${coverUrl})`, "");
  lines.push("## Book details", "");
  const rows: Array<[string, string | undefined]> = [
    ["Author", book.authors?.map(inline).join(", ")],
    ["Series", book.series ? `${inline(book.series.name)}${book.series.position ? ` #${inline(book.series.position)}` : ""}` : undefined],
    ["Published", book.publishedDate],
    ["Edition", book.edition],
    ["Format", book.format],
    ["Publisher", book.publisher],
    ["Pages", book.pageCount?.toString()],
    ["Language", book.language],
    ["ISBN-10", book.isbn10],
    ["ISBN-13", book.isbn13],
    ["ASIN", book.asin],
    ["Categories", book.categories?.map(inline).join(", ")],
  ];
  for (const [label, value] of rows) if (value) lines.push(`- **${label}:** ${inline(value)}`);
  if (book.ratings?.length) {
    for (const rating of book.ratings) {
      lines.push(`- **Rating (${rating.provider}):** ${rating.average}/5${rating.count ? ` (${rating.count} ratings)` : ""}`);
    }
  }
  if (book.description) lines.push("", "## Description", "", book.description.trim());
  if (book.sources.length) {
    lines.push("", "## Sources", "");
    const seen = new Set<string>();
    for (const source of book.sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      lines.push(`- [${linkLabel(source.provider)}](${source.url})`);
    }
  }
  lines.push("", "---", `Kaneo Books ID: ${book.identifier.canonical}`);
  return `${lines.join("\n").trim()}\n`;
}

export function extractCanonicalIds(description: string | null | undefined): string[] {
  if (!description) return [];
  return [...description.matchAll(/^Kaneo Books ID:\s*(isbn13:\d{13}|asin:[A-Z0-9]{10})\s*$/gim)].map(
    (match) => match[1]!.toLowerCase(),
  );
}

export function taskTitle(book: MergedBook): string {
  return `${book.title}${book.authors?.[0] ? ` — ${book.authors[0]}` : ""}`;
}
