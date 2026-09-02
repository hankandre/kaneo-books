import { z } from "zod";
import { fetchJson, htmlToText } from "../http.ts";
import { StartRateLimiter } from "../rate-limit.ts";
import type { BookIdentifier, MetadataProvider, ProviderRecord } from "../types.ts";

const authorSchema = z.object({ name: z.string() });
const responseSchema = z.record(
  z.string(),
  z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    authors: z.array(authorSchema).optional(),
    publishers: z.array(z.object({ name: z.string() })).optional(),
    publish_date: z.string().optional(),
    number_of_pages: z.number().optional(),
    subjects: z.array(z.object({ name: z.string() })).optional(),
    cover: z.record(z.string(), z.string()).optional(),
    identifiers: z.record(z.string(), z.array(z.string())).optional(),
    notes: z.union([z.string(), z.object({ value: z.string() })]).optional(),
  }),
);

export class OpenLibraryProvider implements MetadataProvider {
  readonly name = "open-library" as const;
  private readonly limiter = new StartRateLimiter();

  constructor(private readonly contact?: string) {}

  async lookup(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    if (identifier.kind === "asin") return [];
    return this.limiter.run(this.contact ? 334 : 1000, () => this.lookupNow(identifier));
  }

  private async lookupNow(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    const isbn = identifier.isbn13 ?? identifier.value;
    const key = `ISBN:${isbn}`;
    const url = new URL("https://openlibrary.org/api/books");
    url.searchParams.set("bibkeys", key);
    url.searchParams.set("format", "json");
    url.searchParams.set("jscmd", "data");
    const headers = new Headers({ Accept: "application/json" });
    if (this.contact) headers.set("User-Agent", `kaneo-books/0.1 (${this.contact})`);
    const data = responseSchema.parse(await fetchJson<unknown>(url, { headers }));
    const book = data[key];
    if (!book) return [];
    const ids = book.identifiers ?? {};
    const returned = [...(ids.isbn_10 ?? []), ...(ids.isbn_13 ?? [])].map((value) => value.replace(/[\s-]/g, ""));
    if (returned.length > 0 && !returned.includes(isbn)) return [];
    const coverSizes: Record<string, number> = { small: 180, medium: 360, large: 720 };
    const notes = typeof book.notes === "string" ? book.notes : book.notes?.value;
    return [
      {
        provider: this.name,
        matchedIdentifier: isbn,
        fetchedAt: new Date().toISOString(),
        sourceUrl: book.url,
        title: book.title,
        subtitle: book.subtitle,
        authors: book.authors?.map((author) => author.name),
        publisher: book.publishers?.[0]?.name,
        publishedDate: book.publish_date,
        description: htmlToText(notes),
        isbn10: ids.isbn_10?.[0],
        isbn13: ids.isbn_13?.[0],
        pageCount: book.number_of_pages,
        categories: book.subjects?.map((subject) => subject.name),
        covers: Object.entries(book.cover ?? {}).map(([size, imageUrl]) => ({
          url: imageUrl.replace(/^http:/, "https:"),
          width: coverSizes[size],
          source: this.name,
        })),
      },
    ];
  }
}
