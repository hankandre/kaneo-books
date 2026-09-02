import { afterEach, describe, expect, test } from "bun:test";
import { parseIdentifier } from "../src/identifiers.ts";
import { AmazonProvider, resetAmazonRunState } from "../src/providers/amazon.ts";
import { GoogleBooksProvider } from "../src/providers/google-books.ts";
import { HardcoverProvider } from "../src/providers/hardcover.ts";
import { OpenLibraryProvider } from "../src/providers/open-library.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAmazonRunState();
});

describe("provider contracts", () => {
  test("Google Books keeps only exact identifiers and sanitizes descriptions", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        items: [
          {
            id: "exact",
            volumeInfo: {
              title: "Exact Book",
              authors: ["Author"],
              description: "<p>Hello <b>reader</b>.</p>",
              industryIdentifiers: [{ type: "ISBN_13", identifier: "9780143127741" }],
              imageLinks: { large: "http://images.test/cover.jpg" },
            },
          },
          {
            id: "wrong",
            volumeInfo: {
              title: "Wrong Edition",
              authors: ["Author"],
              industryIdentifiers: [{ type: "ISBN_13", identifier: "9780062316097" }],
            },
          },
        ],
      })) as unknown as typeof fetch;
    const records = await new GoogleBooksProvider().lookup(parseIdentifier("9780143127741"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ title: "Exact Book", description: "Hello reader." });
    expect(records[0]?.covers?.[0]?.url).toStartWith("https:");
  });

  test("Open Library maps exact edition data", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        "ISBN:9780143127741": {
          title: "Library Book",
          authors: [{ name: "Library Author" }],
          identifiers: { isbn_13: ["9780143127741"] },
          publishers: [{ name: "Publisher" }],
          cover: { large: "https://covers.test/book.jpg" },
        },
      })) as unknown as typeof fetch;
    const records = await new OpenLibraryProvider("test@example.com").lookup(parseIdentifier("9780143127741"));
    expect(records[0]).toMatchObject({ title: "Library Book", authors: ["Library Author"], publisher: "Publisher" });
  });

  test("Hardcover queries ISBN/ASIN and maps edition-rich fields", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeDefined();
      return Response.json({
        data: {
          editions: [
            {
              id: 42,
              isbn_13: "9780143127741",
              pages: 464,
              release_date: "2015-09-08",
              edition_format: "Paperback",
              publisher: { name: "Penguin" },
              image: { url: "https://images.test/hardcover.jpg" },
              book: {
                title: "Hardcover Book",
                description: "<p>Description</p>",
                contributions: [{ author: { name: "Hardcover Author" } }],
                book_series: [{ position: 2, series: { name: "Series" } }],
              },
            },
          ],
        },
      });
    }) as unknown as typeof fetch;
    const records = await new HardcoverProvider("token").lookup(parseIdentifier("9780143127741"));
    expect(records[0]).toMatchObject({
      title: "Hardcover Book",
      format: "Paperback",
      pageCount: 464,
      series: { name: "Series", position: "2" },
    });
  });

  test("Amazon parses a direct ASIN product and detects robot checks", async () => {
    globalThis.fetch = (async () =>
      new Response(`
        <html><body>
          <span id="productTitle">Amazon Book</span>
          <div id="bylineInfo">
            <span class="author notFaded"><a>Amazon Author</a> (Author)</span>
            <span class="author notFaded"><a>Audio Narrator</a> (Narrator)</span>
            <span class="author notFaded"><a>Book Publisher</a> (Publisher)</span>
            <span class="more"><a class="showMoreLink">&amp; 0 more</a></span>
          </div>
          <div id="bookDescription_feature_div">A description.</div>
          <img id="landingImage" src="https://images.test/amazon.jpg" />
          <div id="detailBullets_feature_div"><li>Language: English</li><li>Print length: 320 pages</li></div>
        </body></html>
      `)) as unknown as typeof fetch;
    const records = await new AmazonProvider().lookup(parseIdentifier("B0D1234ABC"));
    expect(records[0]).toMatchObject({ title: "Amazon Book", authors: ["Amazon Author"], pageCount: 320 });

    resetAmazonRunState();
    globalThis.fetch = (async () => new Response("Robot Check: enter the characters you see below")) as unknown as typeof fetch;
    await expect(new AmazonProvider().lookup(parseIdentifier("B0D1234ABC"))).rejects.toMatchObject({ code: "amazon_blocked" });
  });
});
