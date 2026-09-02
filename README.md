# kaneo-books

Import exact-edition book metadata into a Kaneo project from ISBNs and Amazon ASINs. The CLI is designed for pasted barcode scans, files, shell pipelines, and automation by AI agents.

## Quick start

Download the standalone executable for your platform from a release, or run it from source with Bun:

```sh
bun install
bun run src/cli.ts configure
bun run src/cli.ts import 9780143127741
```

Once defaults are configured, running `kaneo-books import` opens a minimal repeated-entry prompt. Scan or paste one identifier at a time and submit a blank entry to finish.

Other input forms:

```sh
kaneo-books import 9780143127741 9780062316097
kaneo-books import --file books.txt
printf '9780143127741\n9780062316097\n' | kaneo-books import --json
```

Input files may use whitespace, commas, or newlines and may contain comment lines beginning with `#`.

## Configuration

`kaneo-books configure` stores configuration in the standard per-user configuration directory with owner-only permissions where the platform supports them. `kaneo-books config` displays the saved configuration with secrets redacted. For CI and AI agents, prefer environment variables:

| Variable | Purpose |
| --- | --- |
| `KANEO_API_URL` | Kaneo instance URL or API base URL |
| `KANEO_API_KEY` | Kaneo Bearer API key |
| `KANEO_WORKSPACE` | Workspace ID, when required by the instance |
| `KANEO_PROJECT` | Default project ID, slug, or unique name |
| `KANEO_COLUMN` | Default column slug or unique name |
| `GOOGLE_BOOKS_API_KEY` | Optional Google Books key |
| `HARDCOVER_API_TOKEN` | Optional Hardcover API token |
| `OPENLIBRARY_CONTACT` | Contact email/URL for the Open Library User-Agent |
| `AMAZON_ENABLED` | Opt in to Amazon (`true`/`false`) |
| `AMAZON_DOMAIN` | Regional suffix such as `com` or `co.uk` |
| `AMAZON_COOKIE` | Optional raw Amazon Cookie header |

Flags override environment variables, which override the configuration file. Run `kaneo-books doctor` to verify Kaneo access and list enabled providers.

## Automation contract

Use `--json` for a stable, prompt-free response. stdout contains one JSON object with `schemaVersion: 1`; progress and diagnostics use stderr. Status values are `created`, `skipped`, `unresolved`, `failed`, and `dry-run`.

Exit codes are:

- `0`: all items were created, skipped, or successfully evaluated by `--dry-run`.
- `1`: at least one item was unresolved or failed.
- `2`: invalid usage, configuration, authentication, or target selection.
- `130`: interactive cancellation.

Use `--dry-run --json` to resolve and validate a batch without creating Kaneo tasks.

## Metadata and duplicate behavior

Google Books and Open Library are enabled by default. Hardcover is enabled when a token is present. Only exact identifier matches with a title and author are imported; arbitrary retailer SKUs are rejected. Existing tasks containing the generated `Kaneo Books ID:` footer are skipped project-wide.

Each task includes available cover art, authors, series, publication and edition details, publisher, page count, language, identifiers, categories, provider ratings, description, and source links. Covers are copied into Kaneo when its asset upload API is available; otherwise the source image remains embedded.

Amazon support is experimental and explicitly opt-in. It parses public product HTML, may break when Amazon changes its pages, and stops for the run when CAPTCHA or anti-automation responses are detected. Users are responsible for ensuring their use complies with applicable Amazon terms. The implementation is independently authored and does not copy Grimmory's AGPL source.

## Development

```sh
bun install
bun run check
bun run build
```

The compiled executable is written to `dist/kaneo-books`.
