// Defaults and limits shared by the config, validation, tool and session
// layers. They live here so no layer has to import another one to name a
// number they both use.

export const DEFAULT_BINARY = "winedbg";
// A cold wineprefix takes longer to answer than a warm one; config.ts lets a
// deployment raise this without a rebuild.
export const DEFAULT_READY_TIMEOUT_MS = 10000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
export const MAX_COMMAND_TIMEOUT_MS = 600000;
// A separate limit from MAX_COMMAND_TIMEOUT_MS even at the same value: the two
// bound unrelated waits, and raising the command ceiling must not silently
// raise the first-prompt wait.
export const MAX_READY_TIMEOUT_MS = 600000;
