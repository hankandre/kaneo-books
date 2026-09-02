import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AppError } from "./errors.ts";
import type { AppConfig, EffectiveConfig } from "./types.ts";

const configSchema = z.object({
  kaneo: z
    .object({
      apiUrl: z.string().optional(),
      apiKey: z.string().optional(),
      workspace: z.string().optional(),
      project: z.string().optional(),
      column: z.string().optional(),
    })
    .optional(),
  providers: z
    .object({
      googleBooksApiKey: z.string().optional(),
      hardcoverApiToken: z.string().optional(),
      openLibraryContact: z.string().optional(),
      amazon: z
        .object({
          enabled: z.boolean().optional(),
          domain: z.string().optional(),
          cookie: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export interface ConfigOverrides {
  apiUrl?: string;
  apiKey?: string;
  workspace?: string;
  project?: string;
  column?: string;
  amazon?: boolean;
}

export function configFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.KANEO_BOOKS_CONFIG) return environment.KANEO_BOOKS_CONFIG;
  if (platform() === "win32") {
    return join(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "kaneo-books", "config.json");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "kaneo-books", "config.json");
  }
  return join(environment.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "kaneo-books", "config.json");
}

export async function loadConfig(path = configFilePath()): Promise<AppConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new AppError("invalid_config", `Configuration at ${path} is invalid: ${error.message}`, error);
    }
    throw error;
  }
}

export async function saveConfig(config: AppConfig, path = configFilePath()): Promise<void> {
  const valid = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  if (platform() !== "win32") await chmod(path, 0o600);
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new AppError("invalid_config", `Invalid boolean environment value: ${value}`);
}

function cleanApiUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new AppError("invalid_config", "Kaneo API URL must begin with http:// or https://");
  }
  return normalized.endsWith("/api") ? normalized : `${normalized}/api`;
}

export function resolveConfig(
  file: AppConfig,
  overrides: ConfigOverrides = {},
  environment: NodeJS.ProcessEnv = process.env,
): EffectiveConfig {
  const apiUrl = overrides.apiUrl ?? environment.KANEO_API_URL ?? file.kaneo?.apiUrl;
  const apiKey = overrides.apiKey ?? environment.KANEO_API_KEY ?? file.kaneo?.apiKey;
  if (!apiUrl || !apiKey) {
    throw new AppError(
      "missing_config",
      "Kaneo API URL and API key are required. Run `kaneo-books configure` or set KANEO_API_URL and KANEO_API_KEY.",
    );
  }

  const amazonEnabled =
    overrides.amazon ?? envBoolean(environment.AMAZON_ENABLED) ?? file.providers?.amazon?.enabled ?? false;
  const domain = (environment.AMAZON_DOMAIN ?? file.providers?.amazon?.domain ?? "com").replace(/^amazon\./, "");
  if (!/^[a-z]{2,3}(?:\.[a-z]{2})?$/.test(domain)) {
    throw new AppError("invalid_config", `Invalid Amazon domain: ${domain}`);
  }

  return {
    kaneo: {
      apiUrl: cleanApiUrl(apiUrl),
      apiKey,
      ...(overrides.workspace ?? environment.KANEO_WORKSPACE ?? file.kaneo?.workspace
        ? { workspace: overrides.workspace ?? environment.KANEO_WORKSPACE ?? file.kaneo?.workspace }
        : {}),
      ...(overrides.project ?? environment.KANEO_PROJECT ?? file.kaneo?.project
        ? { project: overrides.project ?? environment.KANEO_PROJECT ?? file.kaneo?.project }
        : {}),
      ...(overrides.column ?? environment.KANEO_COLUMN ?? file.kaneo?.column
        ? { column: overrides.column ?? environment.KANEO_COLUMN ?? file.kaneo?.column }
        : {}),
    },
    providers: {
      ...(environment.GOOGLE_BOOKS_API_KEY ?? file.providers?.googleBooksApiKey
        ? { googleBooksApiKey: environment.GOOGLE_BOOKS_API_KEY ?? file.providers?.googleBooksApiKey }
        : {}),
      ...(environment.HARDCOVER_API_TOKEN ?? file.providers?.hardcoverApiToken
        ? { hardcoverApiToken: environment.HARDCOVER_API_TOKEN ?? file.providers?.hardcoverApiToken }
        : {}),
      ...(environment.OPENLIBRARY_CONTACT ?? file.providers?.openLibraryContact
        ? { openLibraryContact: environment.OPENLIBRARY_CONTACT ?? file.providers?.openLibraryContact }
        : {}),
      amazon: {
        enabled: amazonEnabled,
        domain,
        ...(environment.AMAZON_COOKIE ?? file.providers?.amazon?.cookie
          ? { cookie: environment.AMAZON_COOKIE ?? file.providers?.amazon?.cookie }
          : {}),
      },
    },
  };
}

export function redactConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    kaneo: config.kaneo
      ? { ...config.kaneo, ...(config.kaneo.apiKey ? { apiKey: "[redacted]" } : {}) }
      : undefined,
    providers: config.providers
      ? {
          ...config.providers,
          ...(config.providers.googleBooksApiKey ? { googleBooksApiKey: "[redacted]" } : {}),
          ...(config.providers.hardcoverApiToken ? { hardcoverApiToken: "[redacted]" } : {}),
          amazon: config.providers.amazon
            ? {
                ...config.providers.amazon,
                ...(config.providers.amazon.cookie ? { cookie: "[redacted]" } : {}),
              }
            : undefined,
        }
      : undefined,
  };
}
