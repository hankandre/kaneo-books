#!/usr/bin/env bun
import * as p from "@clack/prompts";
import { Command, CommanderError, Option } from "commander";
import { readFile } from "node:fs/promises";
import { configFilePath, loadConfig, redactConfig, resolveConfig, saveConfig } from "./config.ts";
import { AppError, asAppError } from "./errors.ts";
import { parseInputText } from "./identifiers.ts";
import { importBooks } from "./importer.ts";
import { KaneoClient } from "./kaneo.ts";
import { AmazonProvider, resetAmazonRunState } from "./providers/amazon.ts";
import { GoogleBooksProvider } from "./providers/google-books.ts";
import { HardcoverProvider } from "./providers/hardcover.ts";
import { OpenLibraryProvider } from "./providers/open-library.ts";
import type { AppConfig, ImportItemResult, MetadataProvider } from "./types.ts";

interface ImportCliOptions {
  file?: string;
  workspace?: string;
  project?: string;
  column?: string;
  apiUrl?: string;
  amazon?: boolean;
  dryRun?: boolean;
  json?: boolean;
  cover?: boolean;
  concurrency?: string;
}

function cancelled(value: unknown): asserts value is string {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(130);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function collectInputs(args: string[], file?: string): Promise<string[]> {
  const values = args.flatMap(parseInputText);
  if (file) values.push(...parseInputText(await readFile(file, "utf8")));
  if (!process.stdin.isTTY) values.push(...parseInputText(await readStdin()));
  if (values.length || !process.stdin.isTTY) return values;

  p.intro("Kaneo Books");
  let first = true;
  while (true) {
    const value = await p.text({
      message: first ? "Scan or enter an ISBN/ASIN (blank to finish)" : "Next ISBN/ASIN (blank to finish)",
      placeholder: "9780143127741",
    });
    cancelled(value);
    if (!value.trim()) break;
    values.push(...parseInputText(value));
    first = false;
  }
  return values;
}

async function chooseTarget(
  client: KaneoClient,
  workspace: string | undefined,
  projectSelector: string | undefined,
  columnSelector: string | undefined,
  interactive: boolean,
): Promise<{ project: string; column: string }> {
  let project = projectSelector;
  if (!project) {
    if (!interactive) throw new AppError("missing_target", "Project is required in noninteractive mode.");
    const projects = await client.listProjects(workspace);
    const selected = await p.select({
      message: "Choose a Kaneo project",
      options: projects.map((item) => ({ value: item.id, label: item.name, hint: item.slug })),
    });
    cancelled(selected);
    project = selected;
  }
  const resolvedProject = await client.resolveProject(project, workspace);

  let column = columnSelector;
  if (!column) {
    if (!interactive) throw new AppError("missing_target", "Column is required in noninteractive mode.");
    const columns = await client.listColumns(resolvedProject.id);
    const selected = await p.select({
      message: "Choose a column",
      options: columns.map((item) => ({ value: item.slug, label: item.name, hint: item.slug })),
    });
    cancelled(selected);
    column = selected;
  }
  return { project, column };
}

function providersFor(config: ReturnType<typeof resolveConfig>): MetadataProvider[] {
  const providers: MetadataProvider[] = [
    new GoogleBooksProvider(config.providers.googleBooksApiKey),
    new OpenLibraryProvider(config.providers.openLibraryContact),
  ];
  if (config.providers.hardcoverApiToken) providers.push(new HardcoverProvider(config.providers.hardcoverApiToken));
  if (config.providers.amazon.enabled) {
    providers.push(new AmazonProvider(config.providers.amazon.domain, config.providers.amazon.cookie));
  }
  return providers;
}

function printProgress(result: ImportItemResult): void {
  const label = result.title ?? result.input;
  const icon = { created: "+", skipped: "=", unresolved: "?", failed: "!", "dry-run": "~" }[result.status];
  process.stderr.write(`${icon} ${label}: ${result.status}\n`);
}

async function runImport(args: string[], options: ImportCliOptions): Promise<void> {
  const inputs = await collectInputs(args, options.file);
  if (!inputs.length) throw new AppError("no_input", "No ISBNs or ASINs were supplied.");
  const fileConfig = await loadConfig();
  const config = resolveConfig(fileConfig, {
    apiUrl: options.apiUrl,
    workspace: options.workspace,
    project: options.project,
    column: options.column,
    amazon: options.amazon,
  });
  const client = new KaneoClient(config.kaneo.apiUrl, config.kaneo.apiKey);
  const target = await chooseTarget(
    client,
    config.kaneo.workspace,
    config.kaneo.project,
    config.kaneo.column,
    Boolean(process.stdin.isTTY && process.stdout.isTTY && !options.json),
  );
  const concurrency = Number(options.concurrency ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
    throw new AppError("invalid_option", "Concurrency must be an integer from 1 to 20.");
  }
  resetAmazonRunState();
  const report = await importBooks(client, providersFor(config), {
    inputs,
    project: target.project,
    column: target.column,
    workspace: config.kaneo.workspace,
    dryRun: options.dryRun,
    cover: options.cover,
    concurrency,
    ...(!options.json ? { onProgress: printProgress } : {}),
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    const summary = report.summary;
    process.stdout.write(
      `Created ${summary.created}, skipped ${summary.skipped}, unresolved ${summary.unresolved}, failed ${summary.failed}${summary.dryRun ? `, dry-run ${summary.dryRun}` : ""}.\n`,
    );
  }
  if (report.summary.unresolved || report.summary.failed) process.exitCode = 1;
}

async function configure(): Promise<void> {
  const current = await loadConfig();
  p.intro("Configure Kaneo Books");
  const apiUrl = await p.text({
    message: "Kaneo URL",
    placeholder: "https://cloud.kaneo.app",
    initialValue: current.kaneo?.apiUrl,
    validate: (value) => (/^https?:\/\//.test(value) ? undefined : "Enter an http:// or https:// URL"),
  });
  cancelled(apiUrl);
  const apiKey = await p.password({
    message: current.kaneo?.apiKey ? "Kaneo API key (blank keeps current key)" : "Kaneo API key",
    validate: (value) => (!value && !current.kaneo?.apiKey ? "API key is required" : undefined),
  });
  cancelled(apiKey);
  const workspace = await p.text({
    message: "Workspace ID (optional unless your Kaneo instance requires it)",
    initialValue: current.kaneo?.workspace ?? "",
  });
  cancelled(workspace);
  const candidate: AppConfig = {
    ...current,
    kaneo: {
      apiUrl,
      apiKey: apiKey || current.kaneo?.apiKey!,
      ...(workspace ? { workspace } : {}),
    },
  };
  const effective = resolveConfig(candidate);
  const client = new KaneoClient(effective.kaneo.apiUrl, effective.kaneo.apiKey);
  const projects = await client.listProjects(effective.kaneo.workspace);
  const selectedProject = await p.select({
    message: "Default project",
    options: projects.map((item) => ({ value: item.id, label: item.name, hint: item.slug })),
  });
  cancelled(selectedProject);
  const columns = await client.listColumns(selectedProject);
  const selectedColumn = await p.select({
    message: "Default column",
    options: columns.map((item) => ({ value: item.slug, label: item.name, hint: item.slug })),
  });
  cancelled(selectedColumn);

  const googleKey = await p.password({ message: "Google Books API key (optional; blank keeps current)" });
  cancelled(googleKey);
  const hardcoverToken = await p.password({ message: "Hardcover API token (optional; blank keeps current)" });
  cancelled(hardcoverToken);
  const openLibraryContact = await p.text({
    message: "Open Library contact email/URL (optional, enables a higher request rate)",
    initialValue: current.providers?.openLibraryContact ?? "",
  });
  cancelled(openLibraryContact);
  const amazonEnabled = await p.confirm({
    message: "Enable the experimental Amazon scraper?",
    initialValue: current.providers?.amazon?.enabled ?? false,
  });
  if (p.isCancel(amazonEnabled)) process.exit(130);
  let amazonDomain = current.providers?.amazon?.domain ?? "com";
  let amazonCookie = "";
  if (amazonEnabled) {
    const domain = await p.text({ message: "Amazon regional suffix", initialValue: amazonDomain });
    cancelled(domain);
    amazonDomain = domain;
    const cookie = await p.password({ message: "Amazon Cookie header (optional; blank keeps current)" });
    cancelled(cookie);
    amazonCookie = cookie;
  }
  const next: AppConfig = {
    kaneo: {
      ...candidate.kaneo,
      project: selectedProject,
      column: selectedColumn,
    },
    providers: {
      ...(googleKey || current.providers?.googleBooksApiKey
        ? { googleBooksApiKey: googleKey || current.providers?.googleBooksApiKey }
        : {}),
      ...(hardcoverToken || current.providers?.hardcoverApiToken
        ? { hardcoverApiToken: hardcoverToken || current.providers?.hardcoverApiToken }
        : {}),
      ...(openLibraryContact ? { openLibraryContact } : {}),
      amazon: {
        enabled: amazonEnabled,
        domain: amazonDomain,
        ...(amazonCookie || current.providers?.amazon?.cookie
          ? { cookie: amazonCookie || current.providers?.amazon?.cookie }
          : {}),
      },
    },
  };
  await saveConfig(next);
  p.outro(`Saved configuration to ${configFilePath()}`);
}

async function doctor(): Promise<void> {
  const fileConfig = await loadConfig();
  const config = resolveConfig(fileConfig);
  const client = new KaneoClient(config.kaneo.apiUrl, config.kaneo.apiKey);
  const projects = await client.listProjects(config.kaneo.workspace);
  process.stdout.write(`Kaneo authentication: OK (${projects.length} accessible project${projects.length === 1 ? "" : "s"})\n`);
  if (config.kaneo.project) {
    const project = await client.resolveProject(config.kaneo.project, config.kaneo.workspace);
    const columns = await client.listColumns(project.id);
    process.stdout.write(`Default project: ${project.name} (${columns.length} columns)\n`);
    if (config.kaneo.column) {
      const column = await client.resolveColumn(project.id, config.kaneo.column);
      process.stdout.write(`Default column: ${column.name}\n`);
    }
  }
  process.stdout.write(`Providers: ${providersFor(config).map((provider) => provider.name).join(", ")}\n`);
}

const program = new Command()
  .name("kaneo-books")
  .description("Import book metadata into Kaneo from ISBNs and ASINs")
  .version("0.1.1")
  .showSuggestionAfterError();

function addImportOptions(command: Command): Command {
  return command
    .option("-f, --file <path>", "read identifiers from a file")
    .option("--workspace <id>", "Kaneo workspace ID")
    .option("-p, --project <id-or-name>", "Kaneo project")
    .option("-c, --column <slug-or-name>", "Kaneo column")
    .option("--api-url <url>", "Kaneo API or instance URL")
    .addOption(new Option("--amazon", "enable the experimental Amazon provider").default(undefined))
    .option("--dry-run", "resolve metadata without creating tasks")
    .option("--json", "write a versioned JSON report to stdout")
    .option("--no-cover", "do not embed or upload cover art")
    .option("--concurrency <number>", "number of books processed concurrently", "4");
}

addImportOptions(program.command("import [identifiers...]").description("import books")).action(runImport);
program.command("configure").description("configure credentials and defaults").action(configure);
const configCommand = program.command("config").description("inspect configuration");
const showConfig = async () => {
    process.stdout.write(`${JSON.stringify(redactConfig(await loadConfig()), null, 2)}\n`);
};
configCommand.action(showConfig);
configCommand.command("show").description("show redacted configuration").action(showConfig);
program.command("doctor").description("verify Kaneo access and provider configuration").action(doctor);

program.exitOverride();
const knownCommands = new Set(["import", "configure", "config", "doctor", "help"]);
const firstArgument = process.argv[2];
if (!firstArgument || (!knownCommands.has(firstArgument) && !["--help", "-h", "--version", "-V"].includes(firstArgument))) {
  process.argv.splice(2, 0, "import");
}
try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) {
    process.exitCode = 0;
  } else {
  const appError = asAppError(error, "cli_error");
  const wantsJson = process.argv.includes("--json");
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, error: { code: appError.code, message: appError.message } })}\n`);
  } else if (appError.code !== "commander.helpDisplayed" && appError.code !== "commander.version") {
    process.stderr.write(`Error: ${appError.message}\n`);
  }
  if (appError.code !== "commander.helpDisplayed" && appError.code !== "commander.version") process.exitCode = 2;
  }
}
