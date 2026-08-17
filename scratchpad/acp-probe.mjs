import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildSessionConfig,
  readOnlyPermissions,
} from "../skills/devin-review/scripts/lib/devin.mjs";

const repo = process.env.ACP_PROBE_CWD ?? await fs.mkdtemp(path.join(os.tmpdir(), "devin-acp-probe-"));
const ownRepo = !process.env.ACP_PROBE_CWD;
await fs.mkdir(repo, { recursive: true });
if (ownRepo) {
  await fs.writeFile(path.join(repo, "target.txt"), "ORIGINAL\n");
  await fs.writeFile(path.join(repo, "README.md"), "tiny probe repository\n");
}
if (process.env.ACP_PROBE_REPO_MCP === "1") {
  await fs.mkdir(path.join(repo, ".devin"), { recursive: true });
  await fs.writeFile(path.join(repo, ".devin", "mcp_config.json"), JSON.stringify({
    mcpServers: {
      "repo-scope-canary": { url: "http://127.0.0.1:9/mcp", transport: "http" },
    },
  }, null, 2));
}

const configPath = path.join(repo, "probe-config.json");
const probePermissions = process.env.ACP_PROBE_CONFIG_MODE === "permissive"
  ? { deny: [], allow: [] }
  : readOnlyPermissions();
await fs.writeFile(
  configPath,
  `${JSON.stringify(buildSessionConfig({}, probePermissions), null, 2)}\n`,
  { mode: 0o600 },
);

const args = [
  "--config", configPath,
  "--permission-mode", process.env.ACP_PROBE_MODE ?? "auto",
  "--respect-workspace-trust", process.env.ACP_PROBE_TRUST ?? "false",
];
if (process.env.ACP_PROBE_SANDBOX === "1") args.push("--sandbox");
args.push("acp", "--model", process.env.ACP_PROBE_MODEL ?? "swe-1-7");
if (process.env.ACP_PROBE_AGENT_TYPE) args.push("--agent-type", process.env.ACP_PROBE_AGENT_TYPE);

const child = spawn(process.env.ACP_PROBE_DEVIN ?? "devin", args, {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, WINDSURF_API_KEY: undefined },
});

let nextId = 1;
let stdoutBuffer = "";
const pending = new Map();
const notifications = [];
const permissionRequests = [];
const compact = process.env.ACP_PROBE_COMPACT === "1";
const probeStarted = Date.now();

function emit(label, value) {
  const elapsed = process.env.ACP_PROBE_TIMESTAMPS === "1" ? `+${Date.now() - probeStarted}ms ` : "";
  process.stdout.write(`${elapsed}${label} ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function send(message) {
  if (!compact || message.method || message.result?.outcome) emit("SEND", message);
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
  });
}

function choosePermission(params) {
  const strategy = process.env.ACP_PROBE_PERMISSION ?? "reject";
  if (strategy === "cancel") return { outcome: { outcome: "cancelled" } };
  const desired = strategy === "allow" ? "allow_once" : "reject_once";
  const option = params?.options?.find((entry) => entry.kind === desired);
  if (!option) return { outcome: { outcome: "cancelled" } };
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function handle(message) {
  const updateKind = message.params?.update?.sessionUpdate;
  const interestingUpdate = ["agent_message_chunk", "tool_call", "tool_call_update", "plan"].includes(updateKind);
  if (!compact || message.method === "session/request_permission" || interestingUpdate) emit("RECV", message);
  if (message.id !== undefined && !message.method) {
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(Object.assign(new Error(JSON.stringify(message.error)), { rpcError: message.error }));
    else entry.resolve(message.result);
    return;
  }

  if (message.method === "session/request_permission" && message.id !== undefined) {
    permissionRequests.push(message.params);
    send({ jsonrpc: "2.0", id: message.id, result: choosePermission(message.params) });
    return;
  }

  notifications.push(message);
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk;
  for (;;) {
    const newline = stdoutBuffer.indexOf("\n");
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      emit("MALFORMED", { line, error: error.message });
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  if (!compact) for (const line of chunk.split("\n")) if (line) emit("STDERR", line);
});

const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
child.once("error", (error) => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(error);
  }
  pending.clear();
});

let sessionId;
try {
  emit("SPAWN", { cwd: repo, args });
  const initialized = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "devin-review-acp-probe", version: "0.0.0" },
  }, 15000);
  emit("INITIALIZED", compact ? {
    protocolVersion: initialized.protocolVersion,
    agentInfo: initialized.agentInfo,
    sessionCapabilities: initialized.agentCapabilities?.sessionCapabilities,
    mcpConfigPath: initialized._meta?.mcpConfigPath,
  } : initialized);

  const session = await request("session/new", { cwd: repo, mcpServers: [] }, 60000);
  sessionId = session.sessionId;
  emit("SESSION", compact ? {
    sessionId: session.sessionId,
    modes: session.modes,
    configOptions: session.configOptions?.map((option) => ({
      id: option.id,
      name: option.name,
      type: option.type,
      currentValue: option.currentValue,
    })),
  } : session);

  if (process.env.ACP_PROBE_SET_MODE) {
    const changed = await request("session/set_mode", {
      sessionId,
      modeId: process.env.ACP_PROBE_SET_MODE,
    }, 15000);
    emit("SET_MODE", changed);
  }

  if (process.env.ACP_PROBE_SET_CONFIG_ID) {
    const changed = await request("session/set_config_option", {
      sessionId,
      configId: process.env.ACP_PROBE_SET_CONFIG_ID,
      value: process.env.ACP_PROBE_SET_CONFIG_VALUE,
    }, 15000);
    emit("SET_CONFIG", changed);
  }

  if (process.env.ACP_PROBE_PROMPT) {
    const promptResult = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: process.env.ACP_PROBE_PROMPT }],
    }, Number(process.env.ACP_PROBE_PROMPT_TIMEOUT ?? 300000));
    emit("PROMPT_RESULT", promptResult);
  }

  if (process.env.ACP_PROBE_FOLLOWUP) {
    const promptResult = await request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: process.env.ACP_PROBE_FOLLOWUP }],
    }, Number(process.env.ACP_PROBE_PROMPT_TIMEOUT ?? 300000));
    emit("FOLLOWUP_RESULT", promptResult);
  }

  if (process.env.ACP_PROBE_DELETE !== "0") {
    try {
      emit("DELETE", await request("session/delete", { sessionId }, 15000));
    } catch (error) {
      emit("DELETE_ERROR", error.message);
    }
  }
} catch (error) {
  emit("ERROR", { message: error.message, rpcError: error.rpcError });
} finally {
  emit("SUMMARY", {
    repo,
    permissionRequests: permissionRequests.length,
    permissionKinds: permissionRequests.map((entry) => entry.toolCall?.kind),
    notificationMethods: [...new Set(notifications.map((entry) => entry.method))],
    sessionUpdateKinds: [...new Set(notifications
      .filter((entry) => entry.method === "session/update")
      .map((entry) => entry.params?.update?.sessionUpdate)
      .filter(Boolean))],
    modeUpdates: notifications
      .filter((entry) => entry.params?.update?.sessionUpdate === "current_mode_update")
      .map((entry) => entry.params.update),
    mcpMessages: notifications
      .filter((entry) => entry.method === "_cognition.ai/output")
      .map((entry) => entry.params?.message)
      .filter((message) => /MCP server '.+' (?:connected successfully|connection failed)/.test(message)),
  });
  try {
    emit("TARGET", await fs.readFile(path.join(repo, "target.txt"), "utf8"));
  } catch {}
  child.kill("SIGTERM");
  const ended = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!ended) child.kill("SIGKILL");
  emit("EXIT", ended ?? await exit);
}
