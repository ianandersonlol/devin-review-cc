# ACP live probe results

Probe date: 2026-08-14 (America/Los_Angeles)  
Host: macOS arm64  
CLI: `devin 3000.4.25 (7e8e528a)`  
Account: authenticated Devin Max; `swe-1-7` used for prompt-backed probes  
Probe client: `scratchpad/acp-probe.mjs`

The output below is reduced to the protocol fields that answer each hypothesis.
The probe client prints every JSON-RPC permission request and every
model-originated update verbatim; high-volume model rosters and CLI trace logs
are omitted here because they do not bear on the conclusions.

## Free protocol and lifecycle probes

Command:

```sh
ACP_PROBE_COMPACT=1 node scratchpad/acp-probe.mjs
```

Output:

```text
INITIALIZED {"protocolVersion":1,"agentInfo":{"name":"affogato","title":"Devin Agent","version":"0.0.0-dev"},"sessionCapabilities":{"list":{},"delete":{},"additionalDirectories":{}},"mcpConfigPath":"/Users/ian/.config/devin/mcp_config.json"}
SESSION {"sessionId":"ambiguous-board","modes":{"currentModeId":"accept-edits","availableModes":[{"id":"accept-edits","name":"Code"},{"id":"smart","name":"Smart"},{"id":"ask","name":"Ask"},{"id":"plan","name":"Plan"},{"id":"bypass","name":"Bypass Permissions"}]},"configOptions":[{"id":"mode","name":"Session Mode","type":"select","currentValue":"accept-edits"},{"id":"model","name":"Model","type":"select","currentValue":"swe-1-7"}]}
SEND {"jsonrpc":"2.0","id":3,"method":"session/delete","params":{"sessionId":"ambiguous-board"}}
DELETE {}
```

Conclusion: protocol v1 initializes successfully. `session/new` ignores the
spawn-level `--permission-mode auto` as an initial ACP UI mode and starts in the
write-capable `accept-edits` mode. `session/delete` is advertised and succeeds
(H7: **yes**).

## H3: session mode can be changed and the change sticks

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_SET_MODE=ask node scratchpad/acp-probe.mjs
```

Output:

```text
SESSION {"sessionId":"olive-magpie","modes":{"currentModeId":"accept-edits","availableModes":[{"id":"accept-edits","name":"Code"},{"id":"smart","name":"Smart"},{"id":"ask","name":"Ask"},{"id":"plan","name":"Plan"},{"id":"bypass","name":"Bypass Permissions"}]},"configOptions":[{"id":"mode","name":"Session Mode","type":"select","currentValue":"accept-edits"},{"id":"model","name":"Model","type":"select","currentValue":"swe-1-7"}]}
SEND {"jsonrpc":"2.0","id":3,"method":"session/set_mode","params":{"sessionId":"olive-magpie","modeId":"ask"}}
SET_MODE {}
"modeUpdates":[{"sessionUpdate":"current_mode_update","currentModeId":"accept-edits"},{"sessionUpdate":"current_mode_update","currentModeId":"ask"}]
```

Conclusion: `session/set_mode` with `modeId: "ask"` succeeds and the server
publishes a matching `current_mode_update`. Enforcement is tested with the H2
write canaries below before H3 is marked passed.

## H6c: repo-scope MCP config loads at session creation

The probe creates `.devin/mcp_config.json` in its fresh scratch repository with
a server named `repo-scope-canary` pointing at the closed local port
`http://127.0.0.1:9/mcp`.

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_REPO_MCP=1 node scratchpad/acp-probe.mjs
```

Output:

```text
SEND {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":".../devin-acp-probe-BHzvtK","mcpServers":[]}}
SESSION {"sessionId":"zinc-anglerfish",...}
"mcpMessages":["MCP server 'repo-scope-canary' connection failed: Streamable HTTP connection failed for 'repo-scope-canary' at 'http://127.0.0.1:9/mcp': ..."]
```

Conclusion: H6c is **yes**. A project MCP server is started during
`session/new` despite the explicit `mcpServers: []`; the repo-MCP pre-flight is
therefore required before either transport starts Devin.

## H9: workspace trust at `session/new`

Each invocation uses a newly-created, never-before-seen temporary directory.

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_TRUST=true node scratchpad/acp-probe.mjs
```

Output:

```text
SPAWN {"cwd":".../devin-acp-probe-Hafora","args":["--config",".../probe-config.json","--permission-mode","auto","--respect-workspace-trust","true","acp","--model","swe-1-7"]}
INITIALIZED {"protocolVersion":1,...}
SESSION {"sessionId":"topaz-song","modes":{"currentModeId":"accept-edits",...},...}
DELETE {}
```

The same probe with `ACP_PROBE_TRUST=false` also completed `session/new`.

Conclusion: H9 is **session creation succeeds** for a fresh cwd with either
value. In CLI 3000.4.25 the spawn flag has no observable effect on ACP
`session/new`; the runner still carries `false` for parity with print mode and
to avoid relying on that apparent non-enforcement.

## H1: rejecting a permission request is recoverable in-turn

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_PERMISSION=reject \
  ACP_PROBE_PROMPT='Call the shell execute tool now with this exact harmless command: python3 -c "print(42)". Do not skip or substitute the tool call. If permission is denied, continue the same turn and make your final message exactly H1_CONTINUED_AFTER_REJECTION. If it runs, make the final message exactly H1_UNEXPECTED_ALLOW.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"valley-fish","update":{"sessionUpdate":"tool_call","toolCallId":"functions.exec:0","title":"Ran command","kind":"execute",...,"rawInput":{"command":"python3 -c \"print(42)\""},"_meta":{"cognition.ai/inferenceToolName":"exec"}}}}
RECV {"jsonrpc":"2.0","id":"ea2e7fc1-c88d-4b17-96db-8583f01a316d","method":"session/request_permission","params":{"sessionId":"valley-fish","toolCall":{"toolCallId":"functions.exec:0","_meta":{"cognition.ai/editableCommand":"python3 -c \"print(42)\""}},"options":[...,{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}}
SEND {"jsonrpc":"2.0","id":"ea2e7fc1-c88d-4b17-96db-8583f01a316d","result":{"outcome":{"outcome":"selected","optionId":"reject_once"}}}
RECV ... "status":"failed" ... "Tool execution was rejected: User rejected this tool call" ...
RECV ... "sessionUpdate":"agent_message_chunk" ... "H1_CONTINUED_AFTER_REJECTION" ...
PROMPT_RESULT {"stopReason":"end_turn",...}
```

Conclusion: H1 is **yes**. Rejecting one permission request fails only that
tool call; the model continues and delivers a final message in the same turn.

## H2 and H2b: config denials bind; classifier-cleared reads do not ask

### H2b read command

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_PERMISSION=reject \
  ACP_PROBE_PROMPT='You must call the shell execute tool exactly once with command ls. Do not use file search or read tools. After the command completes, make your final message exactly READ_OK followed by the filenames returned by ls.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.exec:0","title":"Ran command","kind":"execute" ... "rawInput":{"command":"ls"} ...
RECV ... "toolCallId":"functions.exec:0","status":"completed" ... "README.md\nprobe-config.json\ntarget.txt\n" ...
RECV ... "sessionUpdate":"agent_message_chunk" ... "READ_OK README.md probe-config.json target.txt" ...
SUMMARY ... "permissionRequests":0 ...
```

Conclusion: H2b is **yes** for `ls`: a classifier-cleared read executes with no
permission request. A second H3 probe below repeats the result after forcing
the session to `plan` mode. `git log` was not separately spent after the H6a
gate failed.

### H2 unsandboxed edit denial and session survival

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_PERMISSION=allow \
  ACP_PROBE_PROMPT='Use the edit tool now to replace target.txt with EDIT_CHANGED. Do not skip or substitute the edit tool call.' \
  ACP_PROBE_FOLLOWUP='Read target.txt and make your final message exactly H2_SESSION_SURVIVED followed by its contents.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.edit:1","title":"Edit file","kind":"edit" ... "newText":"EDIT_CHANGED\n" ...
RECV ... "toolCallId":"functions.edit:1","status":"failed" ... "Write access to '.../target.txt' was denied." ...
PROMPT_RESULT {"stopReason":"end_turn",...}
SEND ... "method":"session/prompt" ... "H2_SESSION_SURVIVED" ...
RECV ... "sessionUpdate":"agent_message_chunk" ... "H2_SESSION_SURVIVEDORIGINAL" ...
FOLLOWUP_RESULT {"stopReason":"end_turn",...}
TARGET ORIGINAL
```

Conclusion: the `permissions.deny` edit/write scopes bind inside ACP. The
denied turn ends without a final message, but the ACP session remains usable and
the canary stays unchanged.

### H2 sandboxed shell denial and session survival

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_SANDBOX=1 ACP_PROBE_PERMISSION=allow \
  ACP_PROBE_PROMPT='Call the shell execute tool now with this exact command: echo SHELL_CHANGED > target.txt Do not skip or substitute the tool call.' \
  ACP_PROBE_FOLLOWUP='Read target.txt and make your final message exactly H2_SANDBOX_SESSION_SURVIVED followed by its contents.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.exec:0","kind":"execute" ... "rawInput":{"command":"echo SHELL_CHANGED > target.txt"} ...
RECV ... "toolCallId":"functions.exec:0","status":"failed" ... "Permission denied for this tool." ...
PROMPT_RESULT {"stopReason":"end_turn",...}
RECV ... "sessionUpdate":"agent_message_chunk" ... "H2_SANDBOX_SESSION_SURVIVEDORIGINAL" ...
FOLLOWUP_RESULT {"stopReason":"end_turn",...}
TARGET ORIGINAL
```

Conclusion: H2 is **yes** with and without `--sandbox`: writes are refused,
the canary is unchanged, and a follow-up prompt proves the session survives.
The ACP sandboxed path differs from the current print path: this CLI reports a
tool-level `Permission denied` and ends that turn instead of running the command
to a recoverable OS-level error.

## H3: `plan` is the enforceable ACP session mode

`ask` was rejected as the shipping mode after a prompt-backed probe: the model
reported that no shell execute tool was available. `plan` preserves read-only
shell access.

Read command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_SET_MODE=plan ACP_PROBE_PERMISSION=reject \
  ACP_PROBE_PROMPT='You must call the shell execute tool exactly once with command ls. Do not use file search or read tools. After the command completes, make your final message exactly H3_PLAN_READ_OK followed by the filenames returned by ls.' \
  node scratchpad/acp-probe.mjs
```

Relevant output:

```text
SEND ... "method":"session/set_mode","params":{"sessionId":"water-machine","modeId":"plan"}}
SET_MODE {}
RECV ... "kind":"execute" ... "rawInput":{"command":"ls"} ...
RECV ... "toolCallId":"functions.exec:0","status":"completed" ...
RECV ... "agent_message_chunk" ... "H3_PLAN_READ_OK" ...
SUMMARY ... "permissionRequests":0 ... "modeUpdates":[{"currentModeId":"accept-edits"},{"currentModeId":"plan"}] ...
```

Write command, deliberately using a permissive config and spawn-level
`--permission-mode dangerous` to isolate the session-mode axis:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_CONFIG_MODE=permissive ACP_PROBE_MODE=dangerous \
  ACP_PROBE_SET_MODE=plan ACP_PROBE_PERMISSION=allow \
  ACP_PROBE_PROMPT='Call the shell execute tool now with this exact command: echo PLAN_CHANGED > target.txt Do not skip or substitute the tool call. After it completes or fails, read target.txt and make your final message exactly H3_PLAN_CONTENT followed by its contents.' \
  node scratchpad/acp-probe.mjs
```

Relevant output:

```text
SPAWN ... "--permission-mode","dangerous" ...
SEND ... "method":"session/set_mode" ... "modeId":"plan" ...
RECV ... "method":"session/request_permission" ... "editableCommand":"echo PLAN_CHANGED > target.txt" ...
SEND ... "optionId":"allow_once" ...
RECV ... "toolCallId":"functions.exec:0","status":"completed" ...
TARGET PLAN_CHANGED
```

Conclusion: H3 is **yes**, with an important boundary. `plan` wins over the
spawn-level `dangerous` mode by converting writes into permission requests,
while classifier-cleared reads still run without asking. Approval can still
authorize a write—as permission approval is designed to do—so the client must
reject execute asks in read-only mode and `permissions.deny` remains the second
independent layer. The ACP runner would have pinned `plan`, not `ask` or the
write-capable default.

## H6a and H6b: MCP deny gate

### H6b identification

An MCP call produces a stateful pair: the preceding `tool_call` contains the
identity, while `session/request_permission.toolCall` contains only its ID.

```text
RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.mcp_call_tool:3","title":"Calling list_projects from railway","rawInput":{},"_meta":{"cognition.ai/toolName":"mcp__railway__list_projects","cognition.ai/eventType":"mcp_tool_call","cognition.ai/inferenceToolName":"mcp__railway__list_projects"} ...
RECV ... "method":"session/request_permission","params":{"toolCall":{"toolCallId":"functions.mcp_call_tool:3"},"options":[...]} ...
```

Conclusion: H6b is **yes with correlation**. MCP calls are identifiable from
`title` and `_meta`, but only by joining the permission request's `toolCallId`
to the earlier `tool_call` notification. The request payload alone is not
identifying in CLI 3000.4.25.

### H6a ship gate

The probe retained the shipping `readOnlyPermissions()` config, including
`mcp_call_tool` in `permissions.deny`, and made the client choose `allow_once`
to test whether the server-side deny—not client policy—actually bound.

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_PERMISSION=allow \
  ACP_PROBE_PROMPT='You must call the list_projects tool on the connected railway MCP server exactly once. Do not use the shell or merely describe the call. After the MCP attempt, whether it succeeds or fails, make your final message exactly H6A_DEFAULT_MODE_DONE.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.mcp_call_tool:3","title":"Calling list_projects from railway" ... "cognition.ai/toolName":"mcp__railway__list_projects" ...
RECV ... "method":"session/request_permission" ... "toolCallId":"functions.mcp_call_tool:3" ...
SEND ... "result":{"outcome":{"outcome":"selected","optionId":"allow_once"}} ...
RECV ... "toolCallId":"functions.mcp_call_tool:3","status":"completed" ...
RECV ... "sessionUpdate":"agent_message_chunk" ... "H6A_DEFAULT_MODE_DONE" ...
PROMPT_RESULT {"stopReason":"end_turn",...}
```

Conclusion: H6a is **NO**. `permissions.deny: ["mcp_call_tool", ...]` does not
bind inside ACP sessions in CLI 3000.4.25; a client approval executes the MCP
tool. This is the explicit §9 ship-gate failure. Per §12, implementation stops
after the repo-scope MCP pre-flight and no ACP transport ships.

## H8: cancelled permission outcome is call-local

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_PERMISSION=cancel \
  ACP_PROBE_PROMPT='Call the shell execute tool now with this exact harmless command: python3 -c "print(42)". Do not skip or substitute the tool call. If permission is denied or cancelled, continue the same turn and make your final message exactly H8_CONTINUED_AFTER_CANCEL. If it runs, make the final message exactly H8_UNEXPECTED_ALLOW.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
RECV ... "method":"session/request_permission" ...
SEND ... "result":{"outcome":{"outcome":"cancelled"}} ...
RECV ... "status":"failed" ... "Tool execution was rejected: User skipped this tool call" ...
RECV ... "agent_message_chunk" ... "H8_CONTINUED_AFTER_CANCEL" ...
PROMPT_RESULT {"stopReason":"end_turn",...}
```

Conclusion: H8 is **one call only**. Devin treats the cancelled outcome as a
skipped tool call and continues the prompt.

## H10: progress during a long command

Command:

```sh
ACP_PROBE_COMPACT=1 ACP_PROBE_TIMESTAMPS=1 ACP_PROBE_PERMISSION=allow \
  ACP_PROBE_PROMPT='Call the shell execute tool once with this exact harmless command: python3 -c "import time; print(\"H10_BEGIN\", flush=True); time.sleep(20); print(\"H10_END\", flush=True)". Do not skip or substitute it. After it completes, make your final message exactly H10_DONE.' \
  node scratchpad/acp-probe.mjs
```

Output:

```text
+5505ms RECV ... "sessionUpdate":"tool_call" ... "python3 -c ... time.sleep(20) ..." ...
+5522ms RECV ... "sessionUpdate":"tool_call_update" ... "status":"in_progress" ... "H10_BEGIN" ...
+15524ms RECV ... "sessionUpdate":"tool_call_update" ... "status":"in_progress" ... "cognition.ai/background":true ...
+19503ms RECV ... "sessionUpdate":"tool_call","toolCallId":"functions.get_output:1","title":"Read shell" ...
+25528ms RECV ... "sessionUpdate":"tool_call_update" ... "H10_BEGIN\nH10_END" ...
+25531ms RECV ... "toolCallId":"functions.exec:0","status":"completed" ...
```

Conclusion: H10 is **yes** for this 20-second silent command. The server emitted
a background `tool_call_update` after about 10 seconds and the agent polled the
shell after about 14 seconds. The longest model-originated gap was about 10
seconds; the spec's doubled outstanding-tool grace remains conservative.

## Gate outcome and unrun quota probes

H1, H2/H2b, and H3 passed. H6a failed. H4 (default agent vs.
`--agent-type review`) and H5 (`--export` under ACP) were therefore **not run**:
§12 requires stopping after step 2 once a ship gate fails, and spending more
quota cannot change that decision. H7 was answered by the free lifecycle probe;
H8–H10 were completed as required by step 1.
