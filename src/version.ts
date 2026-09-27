import { readFileSync } from "node:fs";

// The version the server reports to MCP clients and prints for --version.
// package.json is the one place it is written, and it is read from there rather
// than restated here, so a client that reads the reported version and a registry
// that reads the manifest cannot disagree about what is running. Nothing
// validates the format: a version the package manager will not accept fails
// there, and a copy in this tree could only drift from it.
const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const declared: unknown = (manifest as { version?: unknown }).version;
if (typeof declared !== "string" || declared.length === 0) {
  throw new Error("package.json declares no version");
}

export const SERVER_VERSION: string = declared;
