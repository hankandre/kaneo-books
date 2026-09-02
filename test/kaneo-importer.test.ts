import { afterEach, describe, expect, test } from "bun:test";
import { importBooks } from "../src/importer.ts";
import { KaneoClient } from "../src/kaneo.ts";
import type { MetadataProvider } from "../src/types.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(): MetadataProvider {
  return {
    name: "google-books",
    async lookup(identifier) {
      return [
        {
          provider: "google-books",
          matchedIdentifier: identifier.value,
          fetchedAt: "2026-01-01T00:00:00.000Z",
          title: "Imported Book",
          authors: ["Book Author"],
          isbn13: identifier.isbn13,
        },
      ];
    },
  };
}

function json(value: unknown): Response {
  return Response.json(value);
}

describe("Kaneo import integration", () => {
  test("creates in the resolved column, skips duplicates, and preserves JSON report counts", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.endsWith("/api/project")) return json([{ id: "p1", name: "Books", slug: "books" }]);
      if (url.endsWith("/api/column/p1")) return json([{ id: "c1", name: "To Read", slug: "to-read" }]);
      if (url.endsWith("/api/task/tasks/p1")) {
        return json([{ id: "old", description: "Kaneo Books ID: isbn13:9780062316097" }]);
      }
      if (url.endsWith("/api/task/p1") && method === "POST") return json({ id: "new-task" });
      throw new Error(`Unexpected request ${method} ${url}`);
    }) as unknown as typeof fetch;

    const report = await importBooks(new KaneoClient("https://kaneo.test/api", "token"), [provider()], {
      inputs: ["9780143127741", "9780062316097", "9780143127741", "not-an-isbn"],
      project: "Books",
      column: "To Read",
      cover: false,
    });
    expect(report.summary).toMatchObject({ received: 4, valid: 2, created: 1, skipped: 2, failed: 1 });
    const create = requests.find((request) => request.method === "POST");
    expect(create?.body).toMatchObject({ title: "Imported Book — Book Author", status: "to-read", priority: "no-priority" });
    expect(JSON.stringify(create?.body)).toContain("Kaneo Books ID: isbn13:9780143127741");
  });

  test("dry-run performs lookups but never creates a task", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      const url = String(input);
      if (url.endsWith("/project")) return json([{ id: "p1", name: "Books", slug: "books" }]);
      if (url.endsWith("/column/p1")) return json([{ id: "c1", name: "To Read", slug: "to-read" }]);
      if (url.endsWith("/task/tasks/p1")) return json([]);
      throw new Error(`Unexpected mutation ${url}`);
    }) as unknown as typeof fetch;
    const report = await importBooks(new KaneoClient("https://kaneo.test/api", "token"), [provider()], {
      inputs: ["9780143127741"],
      project: "p1",
      column: "to-read",
      dryRun: true,
    });
    expect(report.summary.dryRun).toBe(1);
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });

  test("performs the presigned image upload and finalization flow", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/task/image-upload/t1") && init?.method === "PUT") {
        return json({ key: "covers/key", uploadUrl: "https://storage.test/upload", headers: { "x-test": "yes" } });
      }
      if (url === "https://storage.test/upload") return new Response(null, { status: 200 });
      if (url.endsWith("/task/image-upload/t1/finalize")) return json({ id: "asset1", url: "https://kaneo.test/api/asset/asset1" });
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const url = await new KaneoClient("https://kaneo.test/api", "token").uploadTaskImage("t1", {
      bytes: new Uint8Array([1, 2, 3]),
      filename: "cover.jpg",
      contentType: "image/jpeg",
    });
    expect(url).toBe("https://kaneo.test/api/asset/asset1");
    expect(calls).toEqual([
      "PUT https://kaneo.test/api/task/image-upload/t1",
      "PUT https://storage.test/upload",
      "POST https://kaneo.test/api/task/image-upload/t1/finalize",
    ]);
  });

  test("flattens and paginates the current nested Kaneo task response", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/task/tasks/p1")) {
        return json({
          data: {
            columns: [{ tasks: [{ id: "active", description: "active" }] }],
            archivedTasks: [{ id: "archived", description: "archived" }],
            plannedTasks: [],
          },
          pagination: { total: 3, page: 1, pageSize: 2, totalPages: 2 },
        });
      }
      if (url.endsWith("/task/tasks/p1?page=2&limit=100")) {
        return json({
          data: {
            columns: [{ tasks: [{ id: "second-page", description: "second" }] }],
            archivedTasks: [],
            plannedTasks: [],
          },
          pagination: { total: 3, page: 2, pageSize: 2, totalPages: 2 },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const tasks = await new KaneoClient("https://kaneo.test/api", "token").listTasks("p1");
    expect(tasks.map((task) => task.id)).toEqual(["active", "archived", "second-page"]);
    expect(calls).toHaveLength(2);
  });
});
