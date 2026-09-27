// The version the server reports to MCP clients. package.json holds the same
// string for the package manager, and tests/version.test.ts fails the build if
// the two ever drift, since a client that reads one and a registry that reads
// the other would disagree about what it is running.
export const SERVER_VERSION = "1.0.0";
