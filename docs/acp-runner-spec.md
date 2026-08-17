# Spec: ACP transport for the Devin review runner

Status: v3 — reviewed by agy (gemini-3.6-flash-high) and a three-model Devin
panel (swe-1-7, glm-5-2, kimi-k3-high), all findings reconciled · Target:
devin-review-cc · 2026-08-14

## 1. Why

Print mode (`devin -p`) emits nothing until the turn ends. Measured across the
transcripts of every real run of this plugin (Aug 8–13), that single property
caused or worsened every major failure mode:

- **Wall-clock kills of working reviewers.** ~8 timeouts at 600–1500s — under
  the shorter defaults and explicit `--timeout` flags in force at the time (the
  45m default landed later, partly in response). Devin's own tool-call spill
  logs (`$TMPDIR/devin-overflows-*`) show the reviewers actively grepping
  vendored dependencies minutes — sometimes seconds — before each kill. We
  cannot tell a thorough reviewer from a hung one, so the timeout must be a
  generous backstop, and when it fires it discards everything.
- **`blocked_tool` discards the whole turn.** ~7 failures. When the model calls
  a denied tool, the CLI ends the turn: exit 0, empty stdout, empty stderr.
- **A killed run leaves no transcript.** `--export` writes only after a
  completed turn, so the runs that most need forensics have none.
- **No progress signal.** The caller polls a silent process.

`devin acp` (Agent Client Protocol v1, JSON-RPC over stdio, newline-delimited)
inverts the visibility: the client receives `session/update` notifications for
every tool call and message chunk, and *answers* permission requests instead of
watching the CLI kill the turn. The plugin becomes the ACP client (the role an
editor normally plays); Devin remains the agent.

## 2. Goals, non-goals, and the shipping posture

Goals:

1. An ACP transport beside `runDevin()` for review, challenge, and panel,
   sharing the result contract (with additive fields, §4) so failure classes,
   streaming panel output, and rendering survive.
2. Idle-based timeouts driven by **model activity only**, with an
   outstanding-tool grace so a slow command is not mistaken for a hang.
3. Per-call permission decisions with exact denial reporting.
4. A client-side event log per model attempt that survives kills.
5. Print mode as the **default transport at ship**; ACP is opt-in
   (`--transport acp` / `DEVIN_REVIEW_TRANSPORT=acp`) until the H-gate (§9)
   has recorded evidence AND the opt-in path has soaked through real use. Only
   then does a follow-up release flip the default. (Panel-unanimous demand,
   and correct: a CLI that speaks ACP v1 is not thereby proven to enforce our
   permission config inside ACP sessions.)

Non-goals and exclusions:

- **Rescue stays on print mode in this phase.** Rescue's guarantees
  (`Exec(git)`, `Exec(rm)`, `Exec(sudo)`, `Write(.git/**)`) are config-scope
  denials the client cannot re-derive from `{kind, title, rawInput}` — a
  client policy is not a command parser and cannot see through `sh -c`.
  Rescue-over-ACP is a follow-up gated on H2 evidence plus rescue-specific
  canaries.
- No interactive UI, no mid-run user prompts. Policy is decided up front.
- No Devin cloud sessions; local CLI only.
- No change to prompts, findings schema, corroboration, or output formats.

**Sequencing constraint (load-bearing):** H1–H3 and H6a (§9) are cheap to
probe and invalidate the design if false. The probe suite is built and run
**before** the transport module. A "no" on H2+H3 (no enforceable read-only
mechanism inside ACP) or on H6a (MCP deny does not bind) kills the ACP path
for reviews entirely — that outcome must be discovered in step 1, not after
`lib/acp.mjs` exists.

## 3. Verified facts (CLI 3000.4.16, probed 2026-08-13/14, no quota spent)

- `devin acp` speaks ACP `protocolVersion: 1`, ndjson JSON-RPC over stdio.
  `initialize` responds immediately; `agentInfo.version` self-reports
  `0.0.0-dev` (a moving target — hence §10).
- Global flags compose with the subcommand: `devin --config <file>
  --permission-mode <mode> --sandbox acp [--model <m>] [--agent-type review]`
  all parse. Enforcement under ACP is **unverified** (H2/H3).
- `session/new {cwd, mcpServers: []}` succeeds fast and returns `sessionId`,
  a `modes` block — **default `accept-edits`, a writing mode** — plus config
  options including per-session model (`currentValue: "swe-1-7"`).
- The binary's ACP surface (from `strings`) includes `session/set_mode`,
  `session/set_config_option`, `session/list`, `session/delete`,
  `session/resume`, `session/close`, and a `usage` block with token counts —
  mode and model are settable per session through standard methods.
- **MCP exposure, probed to a conclusion:** the session auto-connects MCP
  servers imported from the user's **Claude Code** configuration
  (`~/.claude.json` / `~/.claude/settings.json` — verified by roster match),
  regardless of `mcpServers: []`. No mechanism in this CLI version suppresses
  the import: probed and rejected — `mcp`/`mcp_servers`/`mcp.enabled` keys in
  `--config`, `XDG_CONFIG_HOME` redirection (moves the reported
  `mcpConfigPath` but the roster still connects), `DEVIN_PLUGIN_DISCOVERY`,
  and no `--no-mcp`-shaped flag exists. See §6.
- Noise channels exist: `_cognition.ai/output` (MCP logs) and
  `_cognition.ai/mcp/serversChanged`.
- `session/update` variants observed or documented: `config_option_update`,
  `current_mode_update`, `available_commands_update`, `agent_message_chunk`
  (carries `messageId`), `tool_call`, `tool_call_update`, `plan`,
  `usage_update`.
- `session/prompt` returns `{stopReason: end_turn | max_tokens |
  max_turn_requests | refusal | cancelled}` (enum confirmed in the binary).
  `session/cancel` is a notification; the outstanding prompt then resolves
  `cancelled`.
- `session/request_permission` carries `{sessionId, toolCall, options:
  [{optionId, name, kind: allow_once|allow_always|reject_once|reject_always}]}`;
  the client answers `{outcome: {outcome: "selected", optionId}}` or
  `{outcome: {outcome: "cancelled"}}` (nested shape — the only valid one).
  Tool calls carry `kind` (`read|edit|delete|move|search|execute|think|fetch|
  other`), `title`, `locations`, `rawInput`. Whether MCP-backed tools are
  identifiable (a namespace in `title`/`rawInput`/`_meta`) is unprobed — H6b.
- The binary embeds Windsurf-derived auth machinery; the ACP server prefers
  `WINDSURF_API_KEY` over stored credentials when set. §5 strips it so both
  transports authenticate identically.
- `--agent-type review` exists: "read-only + shell tools" (H4).

## 4. Architecture

One new module, two changed seams:

```
lib/acp.mjs        NEW  transport: spawn, ndjson framing, id correlation,
                        notification dispatch, server->client request handling,
                        per-request timeouts, graceful shutdown. On child exit
                        or stdio EOF, ALL pending request promises reject with
                        a transport error — nothing may await a dead process.
lib/devin.mjs      MOD  runDevinAcp() beside runDevin(); shared arg/config
                        builders; transport selection
lib/panel.mjs      MOD  interpret() gains one early-return branch (below);
                        runPanel unchanged
devin-review.mjs   MOD  --transport acp|print (default print), --idle-timeout,
                        progress wiring
```

**Result contract.** `runDevinAcp()` returns the print-mode shape plus two
additive fields: `{code, stdout, stderr, timedOut, durationSeconds, model,
denials, stopReason, preclassified}`.

- **Pre-classification, stated explicitly** (the panel caught the earlier
  draft claiming "unchanged" while §8 required new behavior): `runDevinAcp()`
  maps stopReasons and JSON-RPC errors into `preclassified: {className,
  reason, retryable}` where §8 defines a mapping, and `interpret()` gains ONE
  new early-return branch: a result carrying `preclassified` short-circuits to
  that class before any stdout/stderr heuristics. No stderr text is ever
  synthesized to trick existing regexes. Print-mode results lack the field and
  take the existing path untouched.
- **`stdout` is the final message, not the whole turn.** Chunks are grouped by
  `messageId`; `stdout` is the text of the **last message** of the turn. Print
  mode prints only the final message, and `interpret()`'s narration heuristics
  (`isEmptyNarration`'s 500-char bound) and `extractJson`'s decoy surface are
  tuned to that; whole-turn concatenation would silently disable the
  `empty_report` retry class and render scratchpad as review. The full stream
  is preserved in the event log. A turn whose last events are tool calls with
  no trailing message yields empty `stdout` → the existing empty-output
  classification, correctly.
- **`denials` schema is frozen to the existing shape** `{tool, detail,
  message}` (what `describeDenials()` and the retry note consume): `tool` =
  the ACP tool name if identifiable, else `kind`; `detail` = the command head
  or first path from `rawInput`/`locations`, truncated as `describeCall()`
  does; `message` = the rejection reason. A unit test asserts a real denial
  renders identically through `describeDenials()` on both transports.

No new dependencies: ndjson JSON-RPC is ~120 lines at pinned v1.

## 5. Session lifecycle

1. Spawn: `devin --config <session-config> --permission-mode <mode>
   --respect-workspace-trust false [--sandbox] acp --model <model>`, cwd =
   repo root. `--respect-workspace-trust false` is carried over deliberately
   (unattended runs cannot answer a trust prompt; H9 probes whether ACP
   enforces trust at `session/new`). Child env = parent env **minus
   `WINDSURF_API_KEY`** so both transports authenticate from the same stored
   credentials. Session config = the same merged file `buildSessionConfig()`
   produces today.
2. `initialize` with `clientCapabilities.fs = {readTextFile: false,
   writeTextFile: false}`. Handshake failure, timeout, or `protocolVersion
   !== 1` → print fallback (§10). Auth-shaped failures classify `auth`; never
   drive the browser flow unattended.
3. `session/new {cwd: repoRoot, mcpServers: []}`. Record every MCP connect
   notification; see §6 for the resulting warning.
4. Force the session out of its writing default via `session/set_mode` /
   `session/set_config_option`, to whichever mode H3 proves enforceable for
   `resolveMode()`'s result. Read-only must hold by **two mechanisms with
   H2/H3 evidence** — session mode and `permissions.deny` — not by
   assumption.
5. `session/prompt` with the existing request text as one text content block.
   The request file still exists on disk (0600) as the artifact of record.
6. Consume notifications until the prompt resolves; handle
   `session/request_permission` per §7.
7. On completion: `session/delete` if present (H7), kill the child; the event
   log is already on disk.

### 5a. Event handling

Two disjoint event classes, and the distinction is load-bearing:

- **Model-originated** — `agent_message_chunk`, `tool_call`,
  `tool_call_update`, `plan`: reset the idle timer, append to the event log,
  and for new `tool_call`s emit one rate-limited stderr progress line
  (`devin-review:   swe-1-7 [execute] git log --oneline -20`).
- **Infrastructure** — `_cognition.ai/*`, `usage_update`,
  `config_option_update`, `available_commands_update`,
  `current_mode_update`: event log only; they do **not** touch the idle
  timer. A chatty MCP server or usage heartbeat must never keep a hung model
  alive past its idle budget. `_cognition.ai/output` with `level: "error"`
  also goes to stderr.

Event log path: `<workdir>/events-<sanitized-model>[-retry].jsonl`, same
`[^A-Za-z0-9._-] → _` sanitization as `exportPathFor()`, `-retry` suffix on
second attempts so attempts never interleave. The kept-workdir message
(`keepReason` paths) names it.

### 5b. Timeouts

- `--idle-timeout DUR` (default **10m**, `none` to disable): fires after that
  long with no **model-originated** event — **unless a tool call is
  outstanding** (a `tool_call` seen without terminal `tool_call_update`), in
  which case the threshold doubles. A quiet tool is more likely slow than
  hung (both glm and swe flagged that a >10m `rg` over a monorepo must not
  reintroduce the §1 failure at a shorter horizon); the wall clock still caps
  the truly wedged case. H10 probes whether the server emits progress events
  during long commands, which would let this grace be tightened later.
  On expiry: `session/cancel`, grace 15s for `stopReason: cancelled`, then
  SIGTERM→SIGKILL; §4's exit-rejection rule guarantees the awaited prompt
  settles. Result: `timedOut: true`, reason naming idleness and last activity.
- `--timeout DUR` (wall clock): backstop for the one case idle cannot catch —
  a model looping tool calls forever. **ACP default 90m** (idle is the
  primary kill; a 45m wall would re-kill exactly the long thorough reviews
  ACP exists to save — glm's point, accepted). Print default stays 45m.
- Per-RPC: `initialize` 15s, `session/new` 60s (MCP startup),
  `session/set_mode` 15s, `session/prompt` unbounded (governed by idle/wall).

## 6. MCP exposure — the honest version

Probing (§3) closed the easy door: **current devin CLI offers no off-switch**
for MCP import, and the import source is the user's Claude Code config. Two
threats, two stances:

1. **User-scope servers (Zapier, railway, …).** Exposure exists in print mode
   today, mitigated by `mcp_call_tool` in `REVIEWER_DENY`. Under ACP the same
   deny travels in `--config`; **H6a — that this deny binds under ACP — is a
   ship gate**, verified live by prompting a reviewer to call an MCP tool and
   asserting failure without turn death. §7 rejects identifiable MCP asks as
   a second layer (H6b determines identifiability). At session start the
   runner logs a loud stderr warning naming every connected MCP server.
   Considered and rejected: swe-1-7's fail-closed-if-any-servers-connect —
   print mode carries the identical exposure today, and failing closed would
   brick the plugin for precisely the users the import targets; the
   differential ACP risk is zero once H6a holds. If H6a FAILS, ACP ships for
   no one.
2. **Repo-scope servers — the sharper threat (kimi).** The CLI documents MCP
   config at user, project (`.devin/mcp_config.json`, committable), and local
   scopes; `--config` replaces none of them, and a repo-shipped stdio server
   command would execute **at session connect, before any permission gate**,
   multiplied by panel concurrency. Requirement: extend
   `detectRepoDevinConfig()` to detect repo-scope MCP config files and
   **refuse to run** unless the user passes `--allow-repo-mcp` (mirroring
   `--allow-hooks`). This applies to the print path too and ships
   independently of ACP, first.

## 7. Permission policy (client-side)

Framing (the whole council converged here, and the earlier draft was wrong):
`decidePermission` runs **only when the agent asks**. In an auto-approving
mode the agent never asks; the client policy is defense-in-depth and a source
of exact denial reporting — it is not the guarantee. The guarantee is H2/H3.
What this layer buys, if H1 holds, is turning today's turn-killing
`blocked_tool` into a recoverable refusal.

`decidePermission(toolCall, options, mode)`, pure and table-tested:

- **Read-only modes reject `execute` asks entirely.** This resolves the
  council's CRITICAL: the print-mode code proves that *allowing* exec
  auto-approves it and bypasses the command classifier
  (`tests/devin.test.mjs`), and a client answering `allow_once` risks exactly
  that bypass. The key observation: commands the CLI's own layers clear
  (classifier-approved reads; sandbox-contained shells) should never generate
  an ask at all — **an ask reaching the client means Devin's gates did not
  clear the command**, and the safe answer is no. H2b verifies the premise
  (classifier-cleared reads produce no ask). If H2b shows every command asks,
  fall back to the documented alternative: client-side write-shape screening
  (redirects, `sed -i`, interpreter one-liners) before allowing — more code,
  same guarantee — or keep rejecting and accept the lost shell reads.
- **Always rejected, every mode**: `write_to_process`, `run_subagent`,
  `request_scope`, `mcp_call_tool`, identifiable MCP-backed calls (H6b), and
  `edit|delete|move` kinds in read-only modes.
- **Foreign-agent CLIs**: reject asks whose command's executable token
  matches `/\b(agy|codex|claude|gemini|devin)\b/` as a word — against the
  parsed command head from `rawInput`, never substring-matched across the
  whole input (a reviewer reading `skills/devin-review/…` must not trip it).
- **Allowed kinds** in read-only modes: `read|search|fetch|think`.
- **Unknown kinds: reject, deliberately.** swe-1-7 argued a `0.0.0-dev` CLI
  will add benign kinds and fail-closed will refuse them; accepted as a real
  cost, rejected as a policy: failing open on a security boundary because the
  vendor might add safe kinds is the wrong trade. With H1, the cost of a
  wrong rejection is one failed tool call, not a dead turn. Unknown kinds are
  logged loudly and the capability probe records the observed taxonomy so new
  kinds get triaged into the tables promptly.
- Map verdicts onto offered options: prefer `reject_once`/`allow_once`; never
  `*_always` (an always-grant outlives our knowledge of it).
- **No option of the desired polarity**: do NOT answer cancelled on the
  assumption it aborts one call — `cancelled` may resolve the whole prompt
  (Zed does; H8 probes Devin). Until proven benign, kill the session
  deliberately and classify `exit_error` with a reason naming the
  un-mappable request. Loud beats ambiguous.
- Every rejection records `{tool, detail, message}` per §4.

## 8. Failure classification mapping

`runDevinAcp()` pre-classifies (§4); `interpret()` short-circuits on it:

| ACP observation                          | Pre-class        |
| ---------------------------------------- | ---------------- |
| `stopReason: refusal`                    | `refusal` (new; retryable false; reason quotes the final message) |
| `stopReason: max_tokens|max_turn_requests` | `context_overflow` |
| JSON-RPC error, auth-shaped              | `auth`           |
| JSON-RPC error, quota/rate-shaped        | `quota`          |
| idle timer fired                         | `timeout` (reason names idleness + last activity) |
| wall clock fired                         | `timeout`        |
| transport death / malformed frames / un-mappable permission ask | `exit_error` (reason attached) |
| `end_turn`, empty final message          | no pre-class → `classifyEmptyOutput(...)` with ACP `denials` |

`--json` gains `transport: "acp"|"print"` and, when present, `stopReason`.
Nothing else in the JSON contract changes.

## 9. Live-verification checklist (probe-first; H1–H3 + H6a gate the ship)

- **H1**: after a rejected `session/request_permission`, the turn continues
  and the model can still produce a review.
- **H2**: `--config` `permissions.deny` binds inside ACP sessions — canary
  write attempts fail without ending the session, with and without
  `--sandbox`. **H2b**: classifier-cleared read commands (`git log`, `ls`)
  produce no permission ask (premise of §7's execute stance).
- **H3**: which mode axis is enforceable — ACP session mode vs. spawn-level
  `--permission-mode` — and whether `session/set_mode` sticks. Pin the
  enforceable one; assert it live.
- **H4**: default agent type + our prompt vs. `--agent-type review`: which
  yields the findings-JSON contract reliably.
- **H5**: `--export` under ACP (drop if redundant beside the event log).
- **H6a**: `mcp_call_tool` deny holds under ACP (attempted call fails, turn
  continues) — ship gate. **H6b**: are MCP-backed tools identifiable in the
  ask payload (namespace in title/rawInput/_meta)? **H6c**: does repo-scope
  `.devin/mcp_config.json` load at `session/new` in this CLI version?
- **H7**: `session/delete` works; else document session residue.
- **H8**: semantics of `{outcome: {outcome: "cancelled"}}` — one call or the
  whole prompt?
- **H9**: workspace trust under ACP: `session/new` on a never-trusted cwd —
  succeeds, fails, or hangs? Does the spawn flag govern it?
- **H10**: does the server emit progress events during a long-running command
  (informs the outstanding-tool idle grace)?

## 10. Compatibility guard and fallback

- A dedicated ACP probe, not `devinFlags()` (swe caught that its regex parses
  only `--flags`, never subcommands): `devin acp --help` exit status detects
  the subcommand cheaply; the `initialize` handshake runs only when a real
  ACP run starts, with its 15s timeout, and any created session is deleted.
  `setup`/`status` report which transport a run would use from config and the
  cheap probe alone — they never spawn an ACP server.
- Handshake failure / timeout / wrong `protocolVersion` → automatic print
  fallback, one stderr line naming the reason. Auth failures do NOT
  auto-fall-back (credentials are identical once `WINDSURF_API_KEY` is
  stripped; print would fail the same way — classify and stop).
- `--transport acp|print` and `DEVIN_REVIEW_TRANSPORT` force a path.
- Touch nothing under `_meta` (`cognition.ai/*`) except behind feature
  detection; the server self-reports `0.0.0-dev`.

## 11. Testing

- **Unit**: mock ACP agent (~100-line node script, ndjson over stdio) driven
  through `runDevinAcp` via the existing `runner` seam. Fixtures: happy turn;
  multi-message turn (asserts last-message stdout; fails under whole-turn
  concatenation); permission asks (reject, allow, no-reject-option, unknown
  kind, MCP-shaped, `devin`-in-path false-positive); idle hang with chatty
  infrastructure noise (asserts noise never resets the timer); outstanding
  slow tool call (asserts the doubled grace); refusal; mid-turn transport
  death (asserts pending promises reject); malformed frame; slow
  `session/new`. `decidePermission` table-tested. Cross-transport denial
  rendering parity through `describeDenials()`.
- **Live** (extends `readonly.live.test.mjs`): canary writes via shell and
  edit-tool under both sandbox states; H1–H3, H6, H8–H10 assertions; one real
  single-model review end-to-end asserting the findings JSON parses.
- **Local acceptance before commit**: `review --transport acp` on this repo's
  own diff; `panel --transport acp` with the default roster; `--transport
  print` still green; `npm test` green.

## 12. Work breakdown (probe-first order)

1. Probe suite for H1–H3, H6, H8–H10 (throwaway scripts fine; results
   recorded in the PR). **Gate: proceed only if H1–H3 and H6a pass.**
2. Repo-scope MCP pre-flight (§6.2) — ships independently, print path too.
3. `lib/acp.mjs` transport + `decidePermission` + unit tests.
4. `runDevinAcp()` + pre-classification branch in `interpret()` + denial
   normalization + classification mapping.
5. CLI flags (`--transport`, `--idle-timeout`), `status`/`setup` reporting,
   `WINDSURF_API_KEY` stripping, event-log integration with kept-workdir
   messages and the tempdir sweep.
6. Live suite additions; full H1–H10 evidence run.
7. SKILL.md / commands / README: transport flag and opt-in status, idle-vs-
   wall doc, event-log artifact, MCP stance, repo-MCP refusal flag.

Definition of done: §11 gates green locally; H1–H10 answered with evidence in
the PR description; print fallback demonstrated by forcing it; default
transport remains print, with the flip criteria (§2.5) written into the README.
