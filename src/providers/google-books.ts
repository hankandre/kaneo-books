import { z } from "zod";
import { fetchJson, htmlToText } from "../http.ts";
import type { BookIdentifier, MetadataProvider, ProviderRecord } from "../types.ts";

const responseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        volumeInfo: z.object({
          title: z.string().optional(),
          subtitle: z.string().optional(),
          authors: z.array(z.string()).optional(),
          publisher: z.string().optional(),
          publishedDate: z.string().optional(),
          description: z.string().optional(),
          industryIdentifiers: z
            .array(z.object({ type: z.string(), identifier: z.string() }))
            .optional(),
          pageCount: z.number().optional(),
          categories: z.array(z.string()).optional(),
          averageRating: z.number().optional(),
          ratingsCount: z.number().optional(),
          imageLinks: z.record(z.string(), z.string()).optional(),
          language: z.string().optional(),
          infoLink: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

function normalize(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export class GoogleBooksProvider implements MetadataProvider {
  readonly name = "google-books" as const;

  constructor(private readonly apiKey?: string) {}

  async lookup(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    if (identifier.kind === "asin") return [];
    const isbn = identifier.isbn13 ?? identifier.value;
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", `isbn:${isbn}`);
    url.searchParams.set("maxResults", "10");
    if (this.apiKey) url.searchParams.set("key", this.apiKey);
    const data = responseSchema.parse(await fetchJson<unknown>(url));

    return (data.items ?? []).flatMap((item) => {
      const info = item.volumeInfo;
      const identifiers = info.industryIdentifiers ?? [];
      const acceptable = new Set([isbn, identifier.value, identifier.isbn10, identifier.isbn13].filter(Boolean));
      if (!identifiers.some((entry) => acceptable.has(normalize(entry.identifier)))) return [];
      const isbn10 = identifiers.find((entry) => entry.type === "ISBN_10")?.identifier;
      const isbn13 = identifiers.find((entry) => entry.type === "ISBN_13")?.identifier;
      const images = Object.entries(info.imageLinks ?? {}).flatMap(([key, imageUrl]) => {
        const size = { smallThumbnail: 128, thumbnail: 256, small: 384, medium: 512, large: 768, extraLarge: 1024 }[key];
        return imageUrl ? [{ url: imageUrl.replace(/^http:/, "https:"), width: size, source: this.name }] : [];
      });
      return [
        {
          provider: this.name,
          matchedIdentifier: isbn,
          fetchedAt: new Date().toISOString(),
          sourceUrl: info.infoLink ?? `https://books.google.com/books?id=${item.id}`,
          title: info.title,
          subtitle: info.subtitle,
          authors: info.authors,
          publisher: info.publisher,
          publishedDate: info.publishedDate,
          description: htmlToText(info.description),
          isbn10,
          isbn13,
          pageCount: info.pageCount,
          categories: info.categories,
          language: info.language,
          covers: images,
          ratings:
            info.averageRating !== undefined
              ? [{ provider: this.name, average: info.averageRating, count: info.ratingsCount }]
              : undefined,
        },
      ];
    });
  }
}
