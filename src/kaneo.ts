import { z } from "zod";
import { AppError } from "./errors.ts";
import { fetchJson, fetchWithRetry } from "./http.ts";

const projectSchema = z.object({
  id: z.string(),
  workspaceId: z.string().optional(),
  slug: z.string().optional(),
  name: z.string(),
});
const columnSchema = z.object({ id: z.string(), slug: z.string(), name: z.string() });
const taskSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  url: z.string().optional(),
});
const taskProjectSchema = z.object({
  columns: z.array(z.object({ tasks: z.array(taskSchema).default([]) })).default([]),
  archivedTasks: z.array(taskSchema).default([]),
  plannedTasks: z.array(taskSchema).default([]),
});
const paginationSchema = z.object({
  page: z.number(),
  totalPages: z.number(),
  pageSize: z.number().optional(),
  total: z.number().optional(),
});
const uploadSchema = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
});
const assetSchema = z.object({ id: z.string(), url: z.string() });

export type KaneoProject = z.infer<typeof projectSchema>;
export type KaneoColumn = z.infer<typeof columnSchema>;
export type KaneoTask = z.infer<typeof taskSchema>;

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "data" in value) return (value as { data: unknown }).data;
  return value;
}

function choose<T extends { id: string; name: string }>(
  values: T[],
  selector: string,
  kind: string,
  aliases: (value: T) => Array<string | undefined>,
): T {
  const exactId = values.find((value) => value.id === selector);
  if (exactId) return exactId;
  const normalized = selector.toLowerCase();
  const matches = values.filter((value) => aliases(value).some((alias) => alias?.toLowerCase() === normalized));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new AppError("ambiguous_target", `More than one ${kind} matches "${selector}"; use its ID.`);
  throw new AppError("target_not_found", `${kind} "${selector}" was not found.`);
}

export interface DownloadedImage {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export class KaneoClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(json = false): Headers {
    const headers = new Headers({ Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" });
    if (json) headers.set("Content-Type", "application/json");
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, retries = 2): Promise<T> {
    return fetchJson<T>(`${this.apiUrl}${path}`, {
      ...init,
      headers: init.headers ?? this.headers(Boolean(init.body)),
      retries,
    });
  }

  async listProjects(workspace?: string): Promise<KaneoProject[]> {
    const query = workspace ? `?workspaceId=${encodeURIComponent(workspace)}` : "";
    const result = unwrap(await this.request<unknown>(`/project${query}`));
    return z.array(projectSchema).parse(result);
  }

  async resolveProject(selector: string, workspace?: string): Promise<KaneoProject> {
    const projects = await this.listProjects(workspace);
    return choose(projects, selector, "project", (project) => [project.slug, project.name]);
  }

  async listColumns(projectId: string): Promise<KaneoColumn[]> {
    const result = unwrap(await this.request<unknown>(`/column/${encodeURIComponent(projectId)}`));
    return z.array(columnSchema).parse(result);
  }

  async resolveColumn(projectId: string, selector: string): Promise<KaneoColumn> {
    const columns = await this.listColumns(projectId);
    return choose(columns, selector, "column", (column) => [column.slug, column.name]);
  }

  async listTasks(projectId: string): Promise<KaneoTask[]> {
    const tasks = new Map<string, KaneoTask>();
    let page = 1;
    let totalPages = 1;
    do {
      const query = page === 1 ? "" : `?page=${page}&limit=100`;
      const response = await this.request<unknown>(`/task/tasks/${encodeURIComponent(projectId)}${query}`);
      if (Array.isArray(response)) {
        for (const task of z.array(taskSchema).parse(response)) tasks.set(task.id, task);
        break;
      }

      const envelope = z
        .object({ data: z.union([z.array(taskSchema), taskProjectSchema]), pagination: paginationSchema.optional() })
        .parse(response);
      if (Array.isArray(envelope.data)) {
        for (const task of envelope.data) tasks.set(task.id, task);
      } else {
        const nested = [
          ...envelope.data.columns.flatMap((column) => column.tasks),
          ...envelope.data.archivedTasks,
          ...envelope.data.plannedTasks,
        ];
        for (const task of nested) tasks.set(task.id, task);
      }
      totalPages = envelope.pagination?.totalPages ?? 1;
      page += 1;
    } while (page <= totalPages);
    return [...tasks.values()];
  }

  async createTask(projectId: string, input: { title: string; description: string; status: string }): Promise<KaneoTask> {
    const result = unwrap(
      await this.request<unknown>(
        `/task/${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ ...input, priority: "no-priority" }),
        },
        0,
      ),
    );
    return taskSchema.parse(result);
  }

  async updateDescription(taskId: string, description: string): Promise<void> {
    await this.request<unknown>(
      `/task/description/${encodeURIComponent(taskId)}`,
      { method: "PUT", headers: this.headers(true), body: JSON.stringify({ description }) },
      0,
    );
  }

  async uploadTaskImage(taskId: string, image: DownloadedImage): Promise<string> {
    const input = {
      filename: image.filename,
      contentType: image.contentType,
      size: image.bytes.byteLength,
      surface: "description",
    };
    const upload = uploadSchema.parse(
      unwrap(
        await this.request<unknown>(
          `/task/image-upload/${encodeURIComponent(taskId)}`,
          { method: "PUT", headers: this.headers(true), body: JSON.stringify(input) },
          0,
        ),
      ),
    );
    const response = await fetchWithRetry(upload.uploadUrl, {
      method: "PUT",
      headers: upload.headers,
      body: image.bytes.buffer.slice(
        image.bytes.byteOffset,
        image.bytes.byteOffset + image.bytes.byteLength,
      ) as ArrayBuffer,
      retries: 1,
      timeoutMs: 30_000,
    });
    if (!response.ok) throw new AppError("cover_upload_failed", `Cover upload returned ${response.status}.`);
    const asset = assetSchema.parse(
      unwrap(
        await this.request<unknown>(
          `/task/image-upload/${encodeURIComponent(taskId)}/finalize`,
          {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify({ ...input, key: upload.key }),
          },
          0,
        ),
      ),
    );
    return asset.url;
  }
}

const acceptedImages = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function downloadCover(url: string): Promise<DownloadedImage> {
  const response = await fetchWithRetry(url, { timeoutMs: 20_000, retries: 1 });
  const contentType = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
  if (!acceptedImages.has(contentType)) throw new AppError("invalid_cover", `Unsupported cover content type: ${contentType || "unknown"}`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 10_000_000) throw new AppError("cover_too_large", "Cover exceeds Kaneo's 10 MB upload limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10_000_000) throw new AppError("cover_too_large", "Cover exceeds Kaneo's 10 MB upload limit.");
  const extension: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return { bytes, contentType, filename: `book-cover.${extension[contentType]}` };
}
