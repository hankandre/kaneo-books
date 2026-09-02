import { AppError } from "./errors.ts";
import type { BookIdentifier } from "./types.ts";

export function normalizeRawIdentifier(input: string): string {
  return input.trim().replace(/[\s-]+/g, "").toUpperCase();
}

export function isValidIsbn10(value: string): boolean {
  if (!/^\d{9}[\dX]$/.test(value)) return false;
  const sum = [...value].reduce((total, char, index) => {
    const digit = char === "X" ? 10 : Number(char);
    return total + digit * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = [...value].reduce(
    (total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return sum % 10 === 0;
}

export function isbn10To13(isbn10: string): string {
  if (!isValidIsbn10(isbn10)) throw new AppError("invalid_isbn", `Invalid ISBN-10: ${isbn10}`);
  const stem = `978${isbn10.slice(0, 9)}`;
  const sum = [...stem].reduce(
    (total, char, index) => total + Number(char) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${stem}${(10 - (sum % 10)) % 10}`;
}

export function parseIdentifier(input: string): BookIdentifier {
  const value = normalizeRawIdentifier(input);
  if (isValidIsbn13(value)) {
    return { kind: "isbn13", value, canonical: `isbn13:${value}`, isbn13: value };
  }
  if (isValidIsbn10(value)) {
    const isbn13 = isbn10To13(value);
    return { kind: "isbn10", value, canonical: `isbn13:${isbn13}`, isbn10: value, isbn13 };
  }
  if (/^[A-Z0-9]{10}$/.test(value) && /[A-Z]/.test(value)) {
    return { kind: "asin", value, canonical: `asin:${value}` };
  }
  throw new AppError(
    "unsupported_identifier",
    `Unsupported identifier "${input}". Expected a checksum-valid ISBN-10/13 or a 10-character ASIN.`,
  );
}

export function parseInputText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .flatMap((line) => line.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function deduplicateIdentifiers(inputs: string[]): Array<{ input: string; identifier: BookIdentifier }> {
  const seen = new Set<string>();
  const result: Array<{ input: string; identifier: BookIdentifier }> = [];
  for (const input of inputs) {
    const identifier = parseIdentifier(input);
    if (seen.has(identifier.canonical)) continue;
    seen.add(identifier.canonical);
    result.push({ input, identifier });
  }
  return result;
}
