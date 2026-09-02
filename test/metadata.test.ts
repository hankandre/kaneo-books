import { describe, expect, test } from "bun:test";
import { extractCanonicalIds, renderDescription, taskTitle } from "../src/description.ts";
import { parseIdentifier } from "../src/identifiers.ts";
import { mergeRecords } from "../src/metadata.ts";
import type { ProviderRecord } from "../src/types.ts";

const now = "2026-01-01T00:00:00.000Z";

describe("metadata merging", () => {
  test("uses deterministic field priorities and unions useful metadata", () => {
    const identifier = parseIdentifier("9780143127741");
    const records: ProviderRecord[] = [
      {
        provider: "google-books",
        matchedIdentifier: identifier.value,
        fetchedAt: now,
        title: "The Body Keeps the Score",
        authors: ["Bessel van der Kolk"],
        description: "Google description",
        categories: ["Psychology"],
        covers: [{ source: "google-books", url: "https://example.test/google.jpg", width: 800 }],
      },
      {
        provider: "hardcover",
        matchedIdentifier: identifier.value,
        fetchedAt: now,
        title: "The Body Keeps the Score",
        authors: ["Bessel van der Kolk"],
        description: "Hardcover description",
        series: { name: "Mind and Body", position: "1" },
        categories: ["Health"],
        covers: [{ source: "hardcover", url: "https://example.test/hardcover.jpg" }],
      },
      {
        provider: "amazon",
        matchedIdentifier: identifier.value,
        fetchedAt: now,
        title: "The Body Keeps the Score",
        authors: ["Bessel van der Kolk"],
        covers: [{ source: "amazon", url: "https://example.test/amazon.jpg" }],
      },
    ];
    const book = mergeRecords(identifier, records);
    expect(book.description).toBe("Google description");
    expect(book.series?.name).toBe("Mind and Body");
    expect(book.covers?.[0]?.source).toBe("amazon");
    expect(book.categories).toEqual(["Psychology", "Health"]);
    expect(book.provenance).toMatchObject({ description: "google-books", series: "hardcover", cover: "amazon" });
  });

  test("requires title and author and rejects ambiguous same-provider results", () => {
    const identifier = parseIdentifier("9780143127741");
    expect(() =>
      mergeRecords(identifier, [{ provider: "google-books", matchedIdentifier: identifier.value, fetchedAt: now, title: "Only title" }]),
    ).toThrow("both title and author");
    expect(() =>
      mergeRecords(identifier, [
        { provider: "google-books", matchedIdentifier: identifier.value, fetchedAt: now, title: "Book One", authors: ["A"] },
        { provider: "google-books", matchedIdentifier: identifier.value, fetchedAt: now, title: "Book Two", authors: ["B"] },
      ]),
    ).toThrow("multiple exact matches");
  });
});

describe("task rendering", () => {
  test("renders rich Markdown and a stable duplicate marker", () => {
    const identifier = parseIdentifier("9780143127741");
    const book = mergeRecords(identifier, [
      {
        provider: "google-books",
        matchedIdentifier: identifier.value,
        fetchedAt: now,
        title: "A Book",
        authors: ["An Author"],
        description: "A useful description.",
        isbn13: identifier.value,
        sourceUrl: "https://books.example/book",
      },
    ]);
    const markdown = renderDescription(book, "https://images.example/cover.jpg");
    expect(markdown).toContain("![Book cover]");
    expect(markdown).toContain("**Author:** An Author");
    expect(markdown).toContain("Kaneo Books ID: isbn13:9780143127741");
    expect(extractCanonicalIds(markdown)).toEqual(["isbn13:9780143127741"]);
    expect(taskTitle(book)).toBe("A Book — An Author");
  });
});
