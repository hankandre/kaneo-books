import { z } from "zod";
import { fetchJson, htmlToText } from "../http.ts";
import { StartRateLimiter } from "../rate-limit.ts";
import type { BookIdentifier, MetadataProvider, ProviderRecord } from "../types.ts";

const editionSchema = z.object({
  id: z.number(),
  isbn_10: z.string().nullable().optional(),
  isbn_13: z.string().nullable().optional(),
  asin: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  pages: z.number().nullable().optional(),
  release_date: z.string().nullable().optional(),
  edition_format: z.string().nullable().optional(),
  image: z.object({ url: z.string().nullable().optional() }).nullable().optional(),
  publisher: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
  book: z
    .object({
      title: z.string().nullable().optional(),
      slug: z.string().nullable().optional(),
      subtitle: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      contributions: z
        .array(z.object({ author: z.object({ name: z.string() }) }))
        .optional(),
      book_series: z
        .array(
          z.object({
            position: z.number().nullable().optional(),
            series: z.object({ name: z.string() }),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
});

const responseSchema = z.object({
  data: z.object({ editions: z.array(editionSchema) }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const query = `
query LookupEdition($value: String!) {
  editions(where: {_or: [{isbn_10: {_eq: $value}}, {isbn_13: {_eq: $value}}, {asin: {_eq: $value}}]}, limit: 10) {
    id isbn_10 isbn_13 asin title subtitle pages release_date edition_format
    image { url }
    publisher { name }
    book {
      title subtitle slug description
      contributions { author { name } }
      book_series { position series { name } }
    }
  }
}`;

export class HardcoverProvider implements MetadataProvider {
  readonly name = "hardcover" as const;
  private readonly limiter = new StartRateLimiter();

  constructor(private readonly token: string) {}

  async lookup(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    return this.limiter.run(1000, () => this.lookupNow(identifier));
  }

  private async lookupNow(identifier: BookIdentifier): Promise<ProviderRecord[]> {
    const response = responseSchema.parse(
      await fetchJson<unknown>("https://api.hardcover.app/v1/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "kaneo-books/0.1",
        },
        body: JSON.stringify({ query, variables: { value: identifier.value } }),
      }),
    );
    if (response.errors?.length) throw new Error(`Hardcover: ${response.errors.map((error) => error.message).join("; ")}`);

    return (response.data?.editions ?? []).flatMap((edition) => {
      const values = [edition.isbn_10, edition.isbn_13, edition.asin].filter(Boolean);
      if (!values.includes(identifier.value) && !values.includes(identifier.isbn13 ?? "")) return [];
      const series = edition.book?.book_series?.[0];
      return [
        {
          provider: this.name,
          matchedIdentifier: identifier.value,
          fetchedAt: new Date().toISOString(),
          sourceUrl: edition.book?.slug ? `https://hardcover.app/books/${edition.book.slug}` : undefined,
          title: edition.title ?? edition.book?.title ?? undefined,
          subtitle: edition.subtitle ?? edition.book?.subtitle ?? undefined,
          authors: edition.book?.contributions?.map((item) => item.author.name),
          description: htmlToText(edition.book?.description),
          publisher: edition.publisher?.name ?? undefined,
          publishedDate: edition.release_date ?? undefined,
          isbn10: edition.isbn_10 ?? undefined,
          isbn13: edition.isbn_13 ?? undefined,
          asin: edition.asin ?? undefined,
          pageCount: edition.pages ?? undefined,
          format: edition.edition_format ?? undefined,
          series: series
            ? { name: series.series.name, ...(series.position != null ? { position: String(series.position) } : {}) }
            : undefined,
          covers: edition.image?.url ? [{ url: edition.image.url, source: this.name }] : undefined,
        },
      ];
    });
  }
}
