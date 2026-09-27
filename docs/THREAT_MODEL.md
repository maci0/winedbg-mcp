# Threat model: winedbg-mcp

Last reviewed: 2026-09-27
Owner: unset. No security owner is recorded for this repository.

Scope: the MCP server in `src/`, the deployment it assumes, and the build in
`package.json` and `.github/workflows/ci.yml`. Every entry point, boundary and
mitigation below carries a file reference so the next pass can re-verify it.
Line numbers are from the revision reviewed on the date above.

## Risk-ranked summary

| # | Threat | Boundary | Impact | Status |
| --- | --- | --- | --- | --- |
| 1 | Any holder of the server's stdio can execute arbitrary debugger commands, which includes commands that run shell programs, read and write target memory, and attach to any PID the user can signal. This is code execution as the server's user, offered by design. | B1, B2 | Total compromise of the host account the server runs under | Unmitigated by design; the only control is who can reach the stdio |
| 2 | A debuggee's stdout is indistinguishable from the debugger's. A program under debug that prints `Wine-dbg>` forges the prompt, ends a reply early, and hides the rest of the output from the caller. | B3 | Wrong debugging conclusions; an operator is told the program's output stopped where the attacker chose | Unmitigated |
| 3 | Debuggee output is returned to the caller verbatim as tool text, so program-controlled bytes reach the LLM that drives the server. | B1, B3 | Prompt injection into the agent: the debugged program can steer the tool-using model | Unmitigated |
| 4 | The stdio transport has no authentication. Any process that inherits or reaches the fds is a full client. | B1 | Same as #1, reached through a weaker path | Unmitigated; documented below as a deployment requirement |
| 5 | A timed-out command leaves the session refusing commands until `winedbg_stop` destroys the debugging state. | B1 | Denial of service against the session, loss of the target's state | Partial: `winedbg_stop` and restart recover it (`src/session.ts:246`) |
| 6 | A reply is buffered up to 1M characters and returned whole, roughly 250k tokens of program-controlled text in one tool result. | B1, B3 | Cost and context exhaustion in the client; the model reads attacker-chosen text at length | Bounded by `MAX_BUFFER_CHARS` (`src/session.ts:12`), unbounded in count |
| 7 | The child is spawned in its own process group and survives this process if it is killed outright. | B2, B4 | Orphaned debuggee keeps running with no owner | Partial: `process.on("exit")` covers normal exits (`src/index.ts:153`); SIGKILL does not |
| 8 | CI actions are referenced by tag, not by commit, and the workflow sets no `permissions:` block. | B5 | A moved upstream tag or a too-broad token changes what CI runs and can read | Unmitigated |
| 9 | No command, argument or start attempt is logged. The server writes three lines to stderr, all about itself: a configuration error (`src/index.ts:21`), the startup line (`src/index.ts:176`) and a fatal startup failure (`src/index.ts:180`). | All | No trail to investigate an incident from | Unmitigated |

Nothing in this repository is a secret store: the environment carries two
non-secret knobs and the code holds no keys, tokens or credentials
(`src/config.ts:6-14`). Confidentiality of the caller's own data is not a
boundary this server defends; it is a pipe.

## 1. Attack surface inventory

Entry points in the code, with the handler that receives each:

| Entry point | Type | Location | Validation |
| --- | --- | --- | --- |
| JSON-RPC over stdio | Transport | `src/index.ts:168` | None at the transport; the SDK frames messages |
| `tools/list` | Request handler | `src/index.ts:39` | None; returns static metadata |
| `tools/call` | Request handler | `src/index.ts:86` | Per-tool, below |
| `winedbg_start` `args` | Tool argument, reaches `spawn` argv | `src/index.ts:92`, `src/session.ts:59` | `requireStringArray` (`src/validate.ts:8`): type only, no length or content check |
| `winedbg_execute` `command` | Tool argument, reaches the debugger's stdin | `src/index.ts:105`, `src/session.ts:288` | `requireString` (`src/validate.ts:16`); single line enforced at `src/session.ts:254` |
| `winedbg_execute` `timeout` | Tool argument | `src/index.ts:106` | `optionalTimeout` (`src/validate.ts:23`): 1 to 600000 ms |
| `winedbg_stop` | Tool argument, none | `src/index.ts:119` | None needed |
| `WINEDBG_MCP_BINARY` | Environment, names the executable | `src/config.ts:6`, read at `src/index.ts:19` | Non-empty after trim (`src/config.ts:45`); unknown `WINEDBG_MCP_*` names abort startup (`src/config.ts:24`) |
| `WINEDBG_MCP_READY_TIMEOUT_MS` | Environment | `src/config.ts:7` | Digits only, 1 to 600000 (`src/config.ts:55`) |
| winedbg stdout and stderr | Child output stream, includes the debuggee's | `src/session.ts:100` | Buffer cap `src/session.ts:205`; no content check |
| Child stdin EPIPE | Stream error event | `src/session.ts:71` | Swallowed on purpose, reported through the command promise |
| SIGINT, SIGTERM, stdin `end` and `close` | Process signals and stream events | `src/index.ts:155-175` | None |

Surface added by the toolchain, not by this code:

- `build/index.js` is published as a `bin` and is a compiled copy of `src/`
  (`package.json:8`). It runs with whatever authority launched it and needs no
  build step at run time.
- The server opens no network socket, no file, and no database. The entire
  remote surface is the inherited stdio pair.
- CI pulls `actions/checkout@v4` and `oven-sh/setup-bun@v2` and runs
  `bun install --frozen-lockfile` (`.github/workflows/ci.yml:12-18`).

Entry points the model previously listed and the code no longer has: none. The
three tools in `src/index.ts:39-83` are the complete tool surface.

## 2. Trust boundaries and data flow

```mermaid
flowchart LR
  classDef trusted fill:#dbeafe,stroke:#3b82f6,color:#1e3a8a
  classDef untrusted fill:#fee2e2,stroke:#ef4444,color:#7f1d1d
  classDef asset fill:#bbf7d0,stroke:#16a34a,color:#14532d

  client["MCP client<br/>stdio writer"]:::untrusted -->|B1: tool arguments| server["winedbg-mcp<br/>src/index.ts"]:::trusted
  env["Deployment environment"]:::trusted -->|B4: two variables| server
  server -->|B2: argv and stdin lines| winedbg["winedbg child<br/>own process group"]:::trusted
  winedbg -->|B3: stdout and stderr| server
  target["Debuggee<br/>attacker-writable stdout"]:::untrusted -->|B3| winedbg
  server -->|tool text, program controlled| client
  winedbg --> mem["Target memory, PID table,<br/>wineprefix files"]:::asset
```

**B1: client to server.** Everything arriving over stdio is untrusted,
including the tool name (`src/index.ts:87`) and both tool arguments. The
validation point is `src/validate.ts`, which checks JSON types and ranges and
nothing else: any string is an acceptable debugger command, and any array of
strings is an acceptable argv.

**B2: server to winedbg.** The server runs `spawn(this.binary, args)` with an
argument array and no shell (`src/session.ts:59`), so no shell metacharacter
reaches a shell. That removes one class of injection and none of the authority:
winedbg is a debugger, its command set includes running and attaching to
processes, and the caller chooses the argv (`winedbg_start` accepts a PID, see
`README.md` usage). The privilege transition is the important one: at this
boundary the caller's data becomes execution as the user running the server.

**B3: winedbg to server.** The child's stdout and stderr are concatenated into
one buffer (`src/session.ts:100-109`) with no provenance. A debuggee writes to
the same pipe, so the server cannot tell debugger output from program output.
Framing depends on the string `Wine-dbg>` appearing in that merged stream
(`src/session.ts:3`, `src/session.ts:91`, `src/session.ts:224`), which is
program-controlled text.

**B4: environment to server.** Read once, before anything else
(`src/index.ts:19`). Whoever sets `WINEDBG_MCP_BINARY` chooses the executable
that B2 spawns. This is a deployment-configuration trust boundary, and the only
one an attacker has to reach to get code execution without a client.

**B5: build to runtime.** `tsc` emits `build/index.js` from `src/` and the
package exposes it as `bin` (`package.json:8`). The lockfile is frozen in CI
(`.github/workflows/ci.yml:16`), which covers transitive drift, and the action
tags are not pinned, which does not.

**Secrets.** There are none to model, and the README claim that the
environment holds no secrets is accurate (`README.md:50`); the code reads two
variables and neither is written anywhere (`src/config.ts:37`).

## 3. Assets and impact

- **Code execution as the server's user.** Reachable through B1 and B2. The
  blast radius is everything that account can read or write: the filesystem, the
  wineprefix, SSH keys in its home, the network it is attached to.
- **Target memory and register state.** A debugger reads arbitrary memory of
  the process it is attached to, and `winedbg_start` accepts a PID
  (`src/index.ts:44`). Anything secret inside the debuggee's address space is
  readable, and nothing in this server limits which PID.
- **The wineprefix and the debugged filesystem.** The debuggee writes where it
  wants; the debugger can write memory and files. Damage here is silent and
  persists after the session ends.
- **Integrity of the debugging result.** Register values, backtraces and program
  output that the caller reads as fact, and that B3 lets a program forge.
- **The caller's model context.** Up to 1M characters of program-controlled text
  per reply reach the LLM (B1, `src/session.ts:231`).
- **Session availability.** One debugger at a time
  (`src/session.ts:48`), one command in flight (`src/session.ts:240`).

## 4. Threats per boundary

### B1, client to server

- **Elevation of privilege.** A client, or anything an LLM reads, calls
  `winedbg_execute` with a command that runs a program or attaches to a PID
  (`src/session.ts:288`, `src/index.ts:105`). Nothing distinguishes a debugging
  command from an execution command.
- **Tampering.** A caller sets `args` to any program path or PID
  (`src/validate.ts:8`).
- **Information disclosure.** `winedbg_execute` returns target memory content
  to the client with no classification step.
- **Denial of service.** A `timeout` of 600000 holds a tool call for ten
  minutes (`src/validate.ts:27`). A timed-out command blocks the next one until
  the prompt returns, and the only escape is `winedbg_stop`, which destroys the
  session (`src/session.ts:246`). An unbounded `args` array is also accepted.
- **Repudiation.** Nothing records which client ran which command.

### B2, server to winedbg

- **Elevation of privilege.** `WINEDBG_MCP_BINARY` names the executable
  (`src/config.ts:41`), so control of the launcher's environment is control of
  the process. The value is logged at startup (`src/config.ts:37`,
  `src/index.ts:176`), which discloses the path but no secret.
- **Tampering.** The `args` array is passed unchanged, so a relative path or a
  name found on `PATH` resolves wherever the server's `PATH` points.
- **Denial of service.** The child is `detached` (`src/session.ts:63`). A
  SIGKILL of the server skips the exit handler at `src/index.ts:153` and leaves
  the debugger and its debuggee running in their own process group.

### B3, winedbg to server

- **Spoofing.** A debuggee that writes `Wine-dbg>` to its stdout satisfies
  `checkOutput` (`src/session.ts:222-231`) and ends the reply wherever it likes.
  `lastIndexOf` means it can also append a prompt to swallow output that
  followed.
- **Tampering.** The pre-command buffer is cleared at `src/session.ts:286`, so
  bytes that arrived between commands are discarded rather than attributed.
- **Information disclosure.** Everything the child writes is returned to the
  client, including output of programs the caller did not intend to expose.
- **Denial of service.** Continuous output is bounded to `MAX_BUFFER_CHARS`
  (`src/session.ts:12`, `src/session.ts:205`), and the drop is reported in the
  reply (`src/session.ts:231`) rather than silently. The bound is per reply, not
  per session, so a program that prompts frequently can be expensive in total.

### B4, environment to server

- **Spoofing and elevation.** Anything that can set the launcher's environment
  (CI job definition, MCP client config file, container spec) chooses the binary
  and both timeouts. There is no signature or allowlist on the path.

### B5, build to runtime

- **Tampering.** Floating action tags in `.github/workflows/ci.yml:12-13` and
  no `permissions:` block mean the workflow runs with the repository's default
  token scope.

## 5. Mitigations mapping

Present in the code:

| Control | Covers | Location |
| --- | --- | --- |
| Argument type and range checks before use | Malformed tool calls reaching the child | `src/validate.ts:8`, `src/validate.ts:16`, `src/validate.ts:23` |
| `spawn` with an argv array, no shell | Shell metacharacter injection at B2 | `src/session.ts:59` |
| Single-line command rejection | Prompt desynchronisation from a multi-line command | `src/session.ts:254` |
| One command in flight | Two callers interleaving output | `src/session.ts:240` |
| Refusal while an abandoned prompt is owed | Output from a timed-out command reaching the wrong caller | `src/session.ts:246`, `src/session.ts:170` |
| Buffer ceiling with a reported drop | Unbounded memory growth from a noisy debuggee | `src/session.ts:12`, `src/session.ts:205`, `src/session.ts:231` |
| Process-group termination on stop, exit and signals | Orphaned debuggee after a clean shutdown | `src/session.ts:182`, `src/index.ts:153`, `src/index.ts:163` |
| Configuration validated at startup, unknown names rejected | A typo or bad value surfacing as a mid-session failure | `src/config.ts:24`, `src/config.ts:45`, `src/config.ts:55` |
| No secrets read, logged or stored | Nothing to disclose through config | `src/config.ts:6-14`, `src/config.ts:37` |
| Frozen lockfile in CI | Dependency drift | `.github/workflows/ci.yml:16` |

Absent, ranked by exploitability then impact:

1. **No authentication on the stdio transport.** Whoever writes to the server's
   stdin is a full client, with the authority in row 1 of the summary. There is
   no handshake, no capability token and no allowlist of clients, and the SDK's
   stdio transport has no hook for one.
2. **No restriction on what winedbg may be asked to do.** A command allowlist
   would need to be defined against the debugger's real command set, which
   changes with the Wine version; the model records the gap rather than
   prescribing the list.
3. **No provenance separation between debugger and debuggee output.** A prompt
   on a channel distinct from the program's, or a stream dedicated to program
   output, is the only way to make row 2 of the summary detectable.
4. **No consent step for destructive or outward-facing debugger commands.**
5. **No audit trail.** Nothing the server writes records an action taken on
   the caller's behalf: commands, their arguments, their timeouts and the sizes
   of the replies are not logged anywhere (`src/index.ts:176`).
6. **No length bound on `args`.**
7. **CI token scope and unpinned action tags** (`.github/workflows/ci.yml`).

Claims to verify before anyone relies on them: the README states there are no
secrets and no config file (`README.md:50`), and the code agrees. No other
security claim in the repository is made, and none of the above mitigations is
claimed in prose anywhere.

Single points of failure carrying several high-impact threats:

- `WinedbgSession` is the only place output is framed and the only place a
  command is sent. Its prompt string assumption (`src/session.ts:3`) underpins
  every anti-desync control listed above.
- The stdio transport is the sole gate for all caller input, and it has no
  authentication layer to bypass or to rely on.
- The server's OS user is the whole blast radius for every row in the summary.

## 6. Abuse cases

Documented from the code path that enables each. None of these was attempted
against a running server.

- **A prompt-injected model becomes a shell.** A document the model reads
  contains instructions; the model calls `winedbg_execute` with a command that
  runs a program. Path: `src/index.ts:105` to `src/session.ts:288`. The only
  checks are non-empty string and no newline.
- **A debugged program dictates the answer.** The program prints the prompt
  string and a clean-looking result of its own, then its real output follows.
  The caller sees the reply end where the program chose. Path:
  `src/session.ts:100` to `src/session.ts:222`.
- **A debugged program spends the caller's tokens.** It emits 1M characters per
  prompt in a loop. Path: `src/session.ts:231`, with the per-reply ceiling at
  `src/session.ts:12`.
- **Read another process.** `winedbg_start` with a PID the server's user can
  signal attaches the debugger to it, and `winedbg_execute` reads its memory.
  Path: `src/index.ts:92` to `src/session.ts:59`.
- **Wedge the session.** A command that never returns holds the debugger, and
  the refusal at `src/session.ts:246` means the only recovery is a stop that
  discards the target's state.
- **Trust placed in the client.** Everything about who may call the tools, and
  which commands they may issue, is the client's problem. The server validates
  JSON shape and assumes the rest (`src/validate.ts:5`).

## 7. Document quality and SECURITY.md

There is no `SECURITY.md` and no disclosure contact, supported-versions table
or security policy in the repository. This model does not invent one: a
disclosure route and a security owner are decisions for whoever owns the
project, and leaving them unset is visible here rather than implied elsewhere.

The model is current as of the last-reviewed date above. The entry-point and
boundary tables are the parts that go stale first; a change to `src/index.ts`,
`src/session.ts` or `src/validate.ts` means re-checking them.

## 8. Response readiness

Noted only; this review builds no infrastructure.

- Security-relevant events have no audit trail. A command that destroyed state,
  a session killed by a timeout, or an output drop at `src/session.ts:231`
  leaves nothing behind except the caller's own transcript.
- There is no documented path from a reported vulnerability to a shipped fix:
  no security policy, no contact, and no branch or release process described in
  the repository.
- No version in this repository records a security fix. `package.json:3` is at
  `1.0.0` and the history has no security-related change.
