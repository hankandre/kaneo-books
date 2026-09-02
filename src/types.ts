export type IdentifierKind = "isbn10" | "isbn13" | "asin";

export interface BookIdentifier {
  kind: IdentifierKind;
  value: string;
  canonical: string;
  isbn10?: string;
  isbn13?: string;
}

export type ProviderName = "google-books" | "open-library" | "hardcover" | "amazon";

export interface SeriesInfo {
  name: string;
  position?: string;
  total?: number;
}

export interface CoverCandidate {
  url: string;
  width?: number;
  height?: number;
  source: ProviderName;
}

export interface ProviderRating {
  provider: ProviderName;
  average: number;
  count?: number;
}

export interface ProviderRecord {
  provider: ProviderName;
  matchedIdentifier: string;
  sourceUrl?: string;
  fetchedAt: string;
  title?: string;
  subtitle?: string;
  authors?: string[];
  description?: string;
  publisher?: string;
  publishedDate?: string;
  isbn10?: string;
  isbn13?: string;
  asin?: string;
  series?: SeriesInfo;
  edition?: string;
  format?: string;
  language?: string;
  pageCount?: number;
  categories?: string[];
  ratings?: ProviderRating[];
  covers?: CoverCandidate[];
}

export interface FieldProvenance {
  [field: string]: ProviderName;
}

export interface MergedBook extends Omit<ProviderRecord, "provider" | "matchedIdentifier" | "fetchedAt" | "sourceUrl"> {
  identifier: BookIdentifier;
  providers: ProviderName[];
  sources: Array<{ provider: ProviderName; url: string }>;
  provenance: FieldProvenance;
  warnings: string[];
}

export interface ProviderContext {
  signal?: AbortSignal;
}

export interface MetadataProvider {
  readonly name: ProviderName;
  lookup(identifier: BookIdentifier, context?: ProviderContext): Promise<ProviderRecord[]>;
}

export type ItemStatus = "created" | "skipped" | "unresolved" | "failed" | "dry-run";

export interface ImportError {
  code: string;
  message: string;
}

export interface ImportItemResult {
  input: string;
  identifier?: BookIdentifier;
  status: ItemStatus;
  title?: string;
  authors?: string[];
  taskId?: string;
  taskUrl?: string;
  providers: ProviderName[];
  warnings: string[];
  error?: ImportError;
}

export interface ImportReport {
  schemaVersion: 1;
  target: { projectId: string; columnSlug: string };
  summary: {
    received: number;
    valid: number;
    created: number;
    skipped: number;
    unresolved: number;
    failed: number;
    dryRun: number;
  };
  results: ImportItemResult[];
}

export interface AppConfig {
  kaneo?: {
    apiUrl?: string;
    apiKey?: string;
    workspace?: string;
    project?: string;
    column?: string;
  };
  providers?: {
    googleBooksApiKey?: string;
    hardcoverApiToken?: string;
    openLibraryContact?: string;
    amazon?: {
      enabled?: boolean;
      domain?: string;
      cookie?: string;
    };
  };
}

export interface EffectiveConfig {
  kaneo: {
    apiUrl: string;
    apiKey: string;
    workspace?: string;
    project?: string;
    column?: string;
  };
  providers: {
    googleBooksApiKey?: string;
    hardcoverApiToken?: string;
    openLibraryContact?: string;
    amazon: {
      enabled: boolean;
      domain: string;
      cookie?: string;
    };
  };
}
