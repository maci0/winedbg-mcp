import {
  CONFIG_VAR_PREFIX,
  DEFAULT_BINARY,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_READY_TIMEOUT_MS,
  LOG_LEVELS,
  type LogLevel,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_READY_TIMEOUT_MS,
} from "./constants.js";

// The only deployment knobs. An MCP client launches this server with no argv it
// controls beyond the script path, so env is the one place a deployment can say
// where winedbg lives, how long a cold wineprefix may take to answer, and how
// much of the server's own diagnostics it wants to keep.
export const BINARY_VAR = "WINEDBG_MCP_BINARY";
export const READY_TIMEOUT_VAR = "WINEDBG_MCP_READY_TIMEOUT_MS";
export const COMMAND_TIMEOUT_VAR = "WINEDBG_MCP_COMMAND_TIMEOUT_MS";
export const LOG_LEVEL_VAR = "WINEDBG_MCP_LOG_LEVEL";
export const PASSTHROUGH_VAR = "WINEDBG_MCP_PASSTHROUGH_ENV";
const KNOWN_VARS: readonly string[] = [
  BINARY_VAR,
  READY_TIMEOUT_VAR,
  COMMAND_TIMEOUT_VAR,
  LOG_LEVEL_VAR,
  PASSTHROUGH_VAR,
];

export type Config = {
  binary: string;
  readyTimeoutMs: number;
  commandTimeoutMs: number;
  logLevel: LogLevel;
  passthroughEnv: string[];
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
    if (key.startsWith(CONFIG_VAR_PREFIX) && !KNOWN_VARS.includes(key)) {
      throw new Error(`Unknown ${CONFIG_VAR_PREFIX}* variable: ${key}. Known: ${KNOWN_VARS.join(", ")}`);
    }
  }

  return {
    binary: parseBinary(env[BINARY_VAR]),
    readyTimeoutMs: parseMilliseconds(
      env[READY_TIMEOUT_VAR],
      READY_TIMEOUT_VAR,
      DEFAULT_READY_TIMEOUT_MS,
      MAX_READY_TIMEOUT_MS,
    ),
    commandTimeoutMs: parseMilliseconds(
      env[COMMAND_TIMEOUT_VAR],
      COMMAND_TIMEOUT_VAR,
      DEFAULT_COMMAND_TIMEOUT_MS,
      MAX_COMMAND_TIMEOUT_MS,
    ),
    logLevel: parseLogLevel(env[LOG_LEVEL_VAR]),
    passthroughEnv: parsePassthrough(env[PASSTHROUGH_VAR]),
  };
}

/** Describe the active configuration for the startup log. No secrets pass through here. */
export function describeConfig(config: Config): string {
  return (
    `${BINARY_VAR}=${config.binary} ${READY_TIMEOUT_VAR}=${config.readyTimeoutMs} ` +
    `${COMMAND_TIMEOUT_VAR}=${config.commandTimeoutMs} ${LOG_LEVEL_VAR}=${config.logLevel} ` +
    `${PASSTHROUGH_VAR}=${config.passthroughEnv.join(",")}`
  );
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  const value = raw.trim().toLowerCase();
  // A level nothing logs at, or one nobody recognizes, silences the server's
  // diagnostics without saying so. Refuse it the way the other values are
  // refused: at startup, with the variable named.
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`${LOG_LEVEL_VAR} must be one of ${LOG_LEVELS.join(", ")}, got "${raw}"`);
  }
  return level;
}

function parseBinary(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_BINARY;
  // Trimmed, like the other two values, and trimmed for more than the emptiness
  // test: a value quoted in a shell or carried in a YAML block scalar arrives
  // with the whitespace still on it, and a path that begins or ends in a space
  // is a path nothing resolves. The same trim makes a value that is nothing but
  // whitespace, including a non-breaking space or a BOM, the empty value it is.
  const value = raw.trim();
  // Set-to-empty is a deployment mistake, not a request for the default: spawn("")
  // fails with ENOENT once someone tries to start a session.
  if (value.length === 0) {
    throw new Error(`${BINARY_VAR} is set but empty. Unset it to use "${DEFAULT_BINARY}".`);
  }
  // A NUL cannot reach execve, so spawn() rejects the path with an ERR_INVALID_ARG_VALUE
  // from a tool call instead of naming the variable that carries it.
  if (value.includes("\0")) {
    throw new Error(`${BINARY_VAR} contains a NUL byte, which no executable path can carry.`);
  }
  return value;
}

/** One of the two waits, in milliseconds. Both take the same shape of value and refuse the same mistakes. */
function parseMilliseconds(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  // Number() accepts "", " " and "0x10"; require plain digits so a typo is an
  // error rather than a surprising value.
  const value = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be a whole number of milliseconds between 1 and ${max}, got "${raw}"`);
  }
  return value;
}

// What a process environment can name at all. Anything else cannot be a
// variable, so naming one here is a typo that would otherwise be forwarded as
// nothing and read as a withheld value.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extra names to forward to the debugger beside the ones it needs to run. The
 * allowlist is what keeps a client's credentials out of a program under debug;
 * this is how a deployment that needs one more variable gets it, one at a time
 * and by name, rather than by handing the whole environment over.
 */
function parsePassthrough(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  // Set-but-empty is a deployment mistake like any other: it reads as "nothing
  // extra" and hides the misspellings the next word would have caught.
  if (raw.trim().length === 0) {
    throw new Error(`${PASSTHROUGH_VAR} is set but empty. Unset it, or name the variables to forward.`);
  }
  const names = raw.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!ENV_NAME.test(name)) {
      throw new Error(
        `${PASSTHROUGH_VAR} entries must be environment variable names, separated by commas, got "${name}"`,
      );
    }
  }
  // A name listed twice forwards the same value twice, so report the shape the
  // caller did not mean rather than a list with a repeat in it.
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`${PASSTHROUGH_VAR} names "${name}" more than once.`);
    }
    seen.add(name);
  }
  return names;
}
