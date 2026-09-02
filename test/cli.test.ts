import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function run(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("CLI contract", () => {
  test("reports version and help successfully", async () => {
    expect(await run(["--version"])).toMatchObject({ exitCode: 0, stdout: "0.1.1\n", stderr: "" });
    const help = await run(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("import [options] [identifiers...]");
  });

  test("supports a bare positional import and returns clean JSON errors", async () => {
    const result = await run(["9780143127741", "--json"], {
      KANEO_BOOKS_CONFIG: `/tmp/kaneo-books-test-missing-${process.pid}.json`,
      KANEO_API_URL: "",
      KANEO_API_KEY: "",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, error: { code: "missing_config" } });
  });
});
