import { describe, expect, test } from "bun:test";
import { redactConfig, resolveConfig } from "../src/config.ts";

describe("configuration", () => {
  test("uses flags over environment over file and normalizes the API URL", () => {
    const config = resolveConfig(
      { kaneo: { apiUrl: "https://file.test", apiKey: "file", project: "file-project" } },
      { project: "flag-project" },
      { KANEO_API_URL: "https://env.test/api/", KANEO_API_KEY: "env", AMAZON_ENABLED: "true" },
    );
    expect(config.kaneo).toMatchObject({ apiUrl: "https://env.test/api", apiKey: "env", project: "flag-project" });
    expect(config.providers.amazon.enabled).toBe(true);
  });

  test("redacts every stored secret", () => {
    const redacted = redactConfig({
      kaneo: { apiKey: "secret" },
      providers: {
        googleBooksApiKey: "google",
        hardcoverApiToken: "hardcover",
        amazon: { cookie: "cookie" },
      },
    });
    expect(redacted.kaneo?.apiKey).toBe("[redacted]");
    expect(redacted.providers?.googleBooksApiKey).toBe("[redacted]");
    expect(redacted.providers?.hardcoverApiToken).toBe("[redacted]");
    expect(redacted.providers?.amazon?.cookie).toBe("[redacted]");
  });
});
