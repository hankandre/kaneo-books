import { describe, expect, test } from "bun:test";
import {
  deduplicateIdentifiers,
  isValidIsbn10,
  isValidIsbn13,
  isbn10To13,
  parseIdentifier,
  parseInputText,
} from "../src/identifiers.ts";

describe("identifiers", () => {
  test("validates and canonicalizes ISBNs", () => {
    expect(isValidIsbn10("0143127748")).toBe(true);
    expect(isValidIsbn13("9780143127741")).toBe(true);
    expect(isbn10To13("0143127748")).toBe("9780143127741");
    expect(parseIdentifier("0-143-12774-8")).toEqual({
      kind: "isbn10",
      value: "0143127748",
      canonical: "isbn13:9780143127741",
      isbn10: "0143127748",
      isbn13: "9780143127741",
    });
  });

  test("recognizes ASINs without misclassifying valid ISBN-10", () => {
    expect(parseIdentifier("B0D1234ABC")).toMatchObject({ kind: "asin", canonical: "asin:B0D1234ABC" });
    expect(() => parseIdentifier("1234567890")).toThrow("Unsupported identifier");
  });

  test("parses comments and common separators", () => {
    expect(parseInputText("# scanned\n9780143127741, 9780062316097\n\nB0D1234ABC")).toEqual([
      "9780143127741",
      "9780062316097",
      "B0D1234ABC",
    ]);
  });

  test("deduplicates ISBN-10 and its ISBN-13", () => {
    expect(deduplicateIdentifiers(["0143127748", "9780143127741"])).toHaveLength(1);
  });
});
