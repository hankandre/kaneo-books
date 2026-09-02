import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "../src/http.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HTTP safety", () => {
  test("redacts API credentials in request errors", async () => {
    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const request = fetchWithRetry("https://example.test/books?key=super-secret&q=book", { retries: 0 });
    await expect(request).rejects.toThrow("key=%5Bredacted%5D");
    await expect(request).rejects.not.toThrow("super-secret");
  });
});
