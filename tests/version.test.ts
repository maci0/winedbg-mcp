// The server reports package.json's version, so the value a client reads is the
// one a registry and an installer read. The format check is a publish-time
// guard: a pre-release or a placeholder belongs in package.json only when the
// package is not meant to be released.

import { describe, expect, test } from "bun:test";
import { SERVER_VERSION } from "../src/version.js";

describe("version", () => {
  test("is the version the manifest declares", async () => {
    const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(manifest.version);
  });

  test("is a release version, not a pre-release or a build placeholder", () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
