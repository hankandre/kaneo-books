import { renderDescription, extractCanonicalIds, taskTitle } from "./description.ts";
import { AppError, asAppError, errorMessage } from "./errors.ts";
import { parseIdentifier } from "./identifiers.ts";
import { downloadCover, KaneoClient } from "./kaneo.ts";
import { lookupBook } from "./metadata.ts";
import type {
  BookIdentifier,
  ImportItemResult,
  ImportReport,
  MetadataProvider,
} from "./types.ts";

export interface ImportOptions {
  inputs: string[];
  project: string;
  column: string;
  workspace?: string;
  dryRun?: boolean;
  cover?: boolean;
  concurrency?: number;
  onProgress?: (result: ImportItemResult) => void;
}

async function mapLimit<T, R>(values: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await work(values[index]!);
      }
    }),
  );
  return results;
}

function classify(error: AppError): "unresolved" | "failed" {
  return ["not_found", "incomplete_metadata", "ambiguous_match"].includes(error.code) ? "unresolved" : "failed";
}

export async function importBooks(
  client: KaneoClient,
  providers: MetadataProvider[],
  options: ImportOptions,
): Promise<ImportReport> {
  const project = await client.resolveProject(options.project, options.workspace);
  const column = await client.resolveColumn(project.id, options.column);
  const tasks = await client.listTasks(project.id);
  const existing = new Set(
    tasks.flatMap((task) => extractCanonicalIds(task.description)).map((identifier) => identifier.toLowerCase()),
  );

  const resultSlots = new Array<ImportItemResult>(options.inputs.length);
  const valid: Array<{ index: number; input: string; identifier: BookIdentifier }> = [];
  const seen = new Set<string>();
  for (const [index, input] of options.inputs.entries()) {
    try {
      const identifier = parseIdentifier(input);
      const key = identifier.canonical.toLowerCase();
      if (seen.has(key)) {
        resultSlots[index] = { input, identifier, status: "skipped", providers: [], warnings: ["Duplicate identifier in this batch."] };
        options.onProgress?.(resultSlots[index]!);
      } else {
        seen.add(key);
        valid.push({ index, input, identifier });
      }
    } catch (error) {
      const appError = asAppError(error, "invalid_identifier");
      resultSlots[index] = {
        input,
        status: "failed",
        providers: [],
        warnings: [],
        error: { code: appError.code, message: appError.message },
      };
      options.onProgress?.(resultSlots[index]!);
    }
  }

  const processed = await mapLimit(valid, Math.max(1, options.concurrency ?? 4), async ({ index, input, identifier }) => {
    const base = { input, identifier, providers: [], warnings: [] } satisfies Omit<ImportItemResult, "status">;
    if (existing.has(identifier.canonical.toLowerCase())) {
      const result: ImportItemResult = { ...base, status: "skipped", warnings: ["A task with this canonical identifier already exists."] };
      options.onProgress?.(result);
      return { index, result };
    }
    try {
      const book = await lookupBook(identifier, providers);
      const remoteCover = options.cover === false ? undefined : book.covers?.[0]?.url;
      const description = renderDescription(book, remoteCover);
      if (options.dryRun) {
        const result: ImportItemResult = {
          ...base,
          status: "dry-run",
          title: book.title,
          authors: book.authors,
          providers: book.providers,
          warnings: book.warnings,
        };
        options.onProgress?.(result);
        return { index, result };
      }

      const task = await client.createTask(project.id, { title: taskTitle(book), description, status: column.slug });
      existing.add(identifier.canonical.toLowerCase());
      const warnings = [...book.warnings];
      if (remoteCover) {
        try {
          const image = await downloadCover(remoteCover);
          const assetUrl = await client.uploadTaskImage(task.id, image);
          await client.updateDescription(task.id, renderDescription(book, assetUrl));
        } catch (error) {
          warnings.push(`Cover was left as a remote image: ${errorMessage(error)}`);
        }
      } else if (options.cover !== false) {
        warnings.push("No cover image was available.");
      }
      const result: ImportItemResult = {
        ...base,
        status: "created",
        title: book.title,
        authors: book.authors,
        taskId: task.id,
        ...(task.url ? { taskUrl: task.url } : {}),
        providers: book.providers,
        warnings,
      };
      options.onProgress?.(result);
      return { index, result };
    } catch (error) {
      const appError = asAppError(error);
      const result: ImportItemResult = {
        ...base,
        status: classify(appError),
        error: { code: appError.code, message: appError.message },
      };
      options.onProgress?.(result);
      return { index, result };
    }
  });

  for (const item of processed) resultSlots[item.index] = item.result;
  const results = resultSlots;
  const count = (status: ImportItemResult["status"]) => results.filter((item) => item.status === status).length;
  return {
    schemaVersion: 1,
    target: { projectId: project.id, columnSlug: column.slug },
    summary: {
      received: options.inputs.length,
      valid: valid.length,
      created: count("created"),
      skipped: count("skipped"),
      unresolved: count("unresolved"),
      failed: count("failed"),
      dryRun: count("dry-run"),
    },
    results,
  };
}
