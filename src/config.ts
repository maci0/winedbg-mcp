import { DEFAULT_BINARY, DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS } from "./constants.js";

// The only deployment knobs. An MCP client launches this server with no argv it
// controls beyond the script path, so env is the one place a deployment can say
// where winedbg lives and how long a cold wineprefix may take to answer.
// The deployment variable that overrides the binary, named in the error a
// mistyped path produces.
export const BINARY_VAR = "WINEDBG_MCP_BINARY";
export const READY_TIMEOUT_VAR = "WINEDBG_MCP_READY_TIMEOUT_MS";
const KNOWN_VARS: readonly string[] = [BINARY_VAR, READY_TIMEOUT_VAR];
const VAR_PREFIX = "WINEDBG_MCP_";

export type Config = {
  binary: string;
  readyTimeoutMs: number;
};

/**
 * Read and validate the environment. Throws on anything it cannot use, so a bad
 * value fails at startup instead of turning into a start timeout or a spawn
 * ENOENT halfway through a debugging session.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // A misspelled name would otherwise be silently ignored and the deployment
  // would run on defaults it thought it had overridden.
  for (const key of Object.keys(env)) {
    if (key.startsWith(VAR_PREFIX) && !KNOWN_VARS.includes(key)) {
      throw new Error(`Unknown ${VAR_PREFIX}* variable: ${key}. Known: ${KNOWN_VARS.join(", ")}`);
    }
  }

  return {
    binary: parseBinary(env[BINARY_VAR]),
    readyTimeoutMs: parseReadyTimeout(env[READY_TIMEOUT_VAR]),
  };
}

/** Describe the active configuration for the startup log. No secrets pass through here. */
export function describeConfig(config: Config): string {
  return `${BINARY_VAR}=${config.binary} ${READY_TIMEOUT_VAR}=${config.readyTimeoutMs}`;
}

function parseBinary(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_BINARY;
  // Set-to-empty is a deployment mistake, not a request for the default: spawn("")
  // fails with ENOENT once someone tries to start a session.
  if (raw.trim().length === 0) {
    throw new Error(`${BINARY_VAR} is set but empty. Unset it to use "${DEFAULT_BINARY}".`);
  }
  // A NUL cannot reach execve, so spawn() rejects the path with an ERR_INVALID_ARG_VALUE
  // from a tool call instead of naming the variable that carries it.
  if (raw.includes("\0")) {
    throw new Error(`${BINARY_VAR} contains a NUL byte, which no executable path can carry.`);
  }
  return raw;
}

function parseReadyTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_READY_TIMEOUT_MS;
  const trimmed = raw.trim();
  // Number() accepts "", " " and "0x10"; require plain digits so a typo is an
  // error rather than a surprising value.
  const value = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value > MAX_READY_TIMEOUT_MS) {
    throw new Error(
      `${READY_TIMEOUT_VAR} must be a whole number of milliseconds between 1 and ${MAX_READY_TIMEOUT_MS}, got "${raw}"`,
    );
  }
  return value;
}
