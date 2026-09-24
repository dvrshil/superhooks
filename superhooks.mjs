#!/usr/bin/env node
// @ts-check
/**
 * superhooks — write a hook once as a Claude Code hook; install it into every coding agent.
 *
 * A superhooks package is any Claude Code plugin (or a bare hooks.json in the settings
 * format). `superhooks add` translates its hooks into each installed agent's native hook
 * config, pointing every entry at `superhooks run`, a shim that converts the agent's
 * stdin/stdout to and from Claude Code's format and provides the environment a Claude
 * plugin expects (CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_OPTION_*).
 *
 * Zero dependencies. Agents are data: see AGENTS.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const HOME = os.homedir();
// The installed copy lives in the state dir, so it finds its state even under another $HOME.
const OWN_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.SUPERHOOKS_HOME
  || (fs.existsSync(path.join(OWN_DIR, "installed.json")) ? OWN_DIR : path.join(HOME, ".superhooks"));
const INSTALLED_FILE = path.join(STATE_DIR, "installed.json");
const STABLE_CLI = path.join(STATE_DIR, "superhooks.mjs");
const LOG_FILE = path.join(STATE_DIR, "superhooks.log");
const DEFAULT_TIMEOUT_SECONDS = 60; // Claude Code's default for command hooks
const TIMEOUT_HEADROOM_SECONDS = 5; // the agent's own timeout must outlast the shim's
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHELL_SAFE_PATTERN = /^[A-Za-z0-9._\/-]+$/;

// ---------------------------------------------------------------- small helpers

/** @param {string} file @param {any} fallback */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return fallback;
    throw new Error(`could not parse ${file}: ${/** @type {Error} */ (error).message}`);
  }
}

/** @param {string} file @param {any} value @param {number} [mode] */
function writeJson(file, value, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.superhooks-tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
  fs.renameSync(temporary, file); // atomic: a crash never leaves a half-written agent config
}

/** Keep one pristine copy of a file before superhooks first changes it. @param {string} file */
function backupOnce(file) {
  const backup = `${file}.superhooks.bak`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
}

/** @param {string} p */
const expandHome = (p) => (p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p);

/** @param {string} message */
function logError(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break a hook
  }
}

// ---------------------------------------------------------------- packages

/**
 * @typedef {{ type: "command", command: string, args?: string[], timeout?: number }} ClaudeCommandHook
 * @typedef {{ matcher?: string, hooks: Array<ClaudeCommandHook | { type: string }> }} ClaudeMatcherGroup
 * @typedef {Record<string, ClaudeMatcherGroup[]>} ClaudeHooks
 * @typedef {{ type: string, title?: string, description?: string, sensitive?: boolean,
 *             required?: boolean, default?: unknown }} UserConfigField
 * @typedef {{ id: string, source: string, root: string, pluginRoot: string,
 *             name: string, hooks: ClaudeHooks, userConfig: Record<string, UserConfigField> }} Package
 */

/**
 * Where a package lives on disk. GitHub `owner/repo` sources are shallow-cloned into the
 * state dir; local paths are used in place so development edits apply immediately.
 * @param {string} source
 * @returns {{ id: string, root: string }}
 */
function fetchPackage(source) {
  const local = path.resolve(expandHome(source));
  if (fs.existsSync(local)) {
    return { id: `local/${path.basename(local).replace(/[^A-Za-z0-9._-]/g, "-")}`, root: local };
  }
  const match = source.match(/^(?:https:\/\/github\.com\/)?([^/\s]+\/[^/\s#]+?)(?:\.git)?\/?$/);
  if (!match || !PACKAGE_ID_PATTERN.test(match[1])) {
    throw new Error(`"${source}" is neither a local path nor a GitHub owner/repo`);
  }
  const id = match[1];
  const root = path.join(STATE_DIR, "packages", id);
  if (fs.existsSync(path.join(root, ".git"))) {
    run("git", ["-C", root, "pull", "--ff-only", "--quiet"]);
  } else {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    run("git", ["clone", "--depth", "1", "--quiet", `https://github.com/${id}.git`, root]);
  }
  return { id, root };
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  }
}

/**
 * Locate the Claude Code plugin inside a package and load its hooks and options.
 * Accepts a marketplace repo (`.claude-plugin/marketplace.json`), a plugin root
 * (`.claude-plugin/plugin.json`), or a bare hooks file / directory with `hooks/hooks.json`.
 * @param {string} id @param {string} source @param {string} root @param {string} [pluginName]
 * @returns {Package}
 */
export function loadPackage(id, source, root, pluginName) {
  if (fs.statSync(root).isFile()) {
    return { id, source, root: path.dirname(root), pluginRoot: path.dirname(root), name: path.basename(root, ".json"),
      hooks: hooksFrom(readJson(root, {})), userConfig: {} };
  }
  let pluginRoot = root;
  const marketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"), null);
  if (marketplace && !fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"))) {
    const local = (marketplace.plugins || []).filter(
      (/** @type {any} */ entry) => typeof entry.source === "string" && entry.source.startsWith("./"));
    const chosen = pluginName ? local.find((/** @type {any} */ entry) => entry.name === pluginName) : local[0];
    if (!chosen) throw new Error(pluginName ? `no plugin "${pluginName}" in ${source}` : `no local plugins in ${source}`);
    if (!pluginName && local.length > 1) {
      throw new Error(`${source} has several plugins (${local.map((/** @type {any} */ e) => e.name).join(", ")}); pick one with --plugin`);
    }
    pluginRoot = path.join(root, chosen.source);
  }
  const manifest = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {});
  let hooks = {};
  if (typeof manifest.hooks === "string") hooks = hooksFrom(readJson(path.join(pluginRoot, manifest.hooks), {}));
  else if (manifest.hooks && typeof manifest.hooks === "object") hooks = hooksFrom(manifest.hooks);
  else hooks = hooksFrom(readJson(path.join(pluginRoot, "hooks", "hooks.json"), {}));
  if (!Object.keys(hooks).length) throw new Error(`no hooks found in ${source}`);
  return { id, source, root, pluginRoot, name: manifest.name || path.basename(pluginRoot),
    hooks, userConfig: manifest.userConfig || {} };
}

/** Accepts `{ hooks: {...} }` (settings/plugin files) or the bare event map. @param {any} value */
function hooksFrom(value) {
  const hooks = value && typeof value === "object" && value.hooks ? value.hooks : value;
  return /** @type {ClaudeHooks} */ (hooks && typeof hooks === "object" ? hooks : {});
}

/**
 * Flatten a package's hooks into addressable commands: event, index, matcher, hook.
 * The (event, index) pair is what agent config entries point back to.
 * @param {ClaudeHooks} hooks
 */
export function listCommands(hooks) {
  /** @type {Array<{ event: string, index: number, matcher: string, hook: ClaudeCommandHook | { type: string } }>} */
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    let index = 0;
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        commands.push({ event, index: index++, matcher: group.matcher || "", hook });
      }
    }
  }
  return commands;
}

// ---------------------------------------------------------------- options (userConfig)

/** @param {string} id */
const optionsFile = (id) => path.join(STATE_DIR, "config", `${id.replace("/", "__")}.json`);

/** @param {string} id @returns {Record<string, unknown>} */
export const readOptions = (id) => readJson(optionsFile(id), {});

/** @param {string} id @param {Record<string, unknown>} options */
function writeOptions(id, options) {
  writeJson(optionsFile(id), options, 0o600); // may hold secrets: owner-only
  fs.chmodSync(optionsFile(id), 0o600);
}

/**
 * Coerce a CLI string to the userConfig field's declared type.
 * @param {UserConfigField} field @param {string} raw
 */
function coerce(field, raw) {
  if (field.type === "number") {
    const number = Number(raw);
    if (Number.isNaN(number)) throw new Error(`expected a number, got "${raw}"`);
    return number;
  }
  if (field.type === "boolean") {
    if (/^(true|1|yes|on)$/i.test(raw)) return true;
    if (/^(false|0|no|off)$/i.test(raw)) return false;
    throw new Error(`expected true or false, got "${raw}"`);
  }
  return raw;
}

/** Ask for one option on the terminal; secrets are read without echo. @param {string} question @param {boolean} secret */
async function ask(question, secret) {
  if (!secret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return String(answer);
  }
  process.stdout.write(question);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let answer = "";
  for await (const chunk of process.stdin) {
    for (const character of String(chunk)) {
      if (character === "\r" || character === "\n" || character === "\u0004") {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return answer;
      }
      if (character === "\u0003") process.exit(130); // Ctrl-C
      if (character === "\u007f") answer = answer.slice(0, -1); // backspace
      else answer += character;
    }
  }
  return answer;
}

/**
 * Resolve every userConfig option: --set values, then saved values, then a prompt
 * (interactive terminals only), then the declared default.
 * @param {Package} pkg @param {Record<string, string>} sets @param {boolean} interactive
 */
async function collectOptions(pkg, sets, interactive) {
  const options = readOptions(pkg.id);
  for (const [key, field] of Object.entries(pkg.userConfig)) {
    if (key in sets) {
      options[key] = coerce(field, sets[key]);
      continue;
    }
    if (key in options) continue;
    if (interactive && process.stdin.isTTY) {
      const hint = field.default !== undefined && !field.sensitive ? ` [${field.default}]` : "";
      const label = `${field.title || key}${field.description ? ` (${field.description})` : ""}${hint}: `;
      const answer = (await ask(label, Boolean(field.sensitive))).trim();
      if (answer) options[key] = coerce(field, answer);
      else if (field.default !== undefined) options[key] = field.default;
    } else if (field.default !== undefined) {
      options[key] = field.default;
    }
    if (field.required && (options[key] === undefined || options[key] === "")) {
      throw new Error(`option "${key}" is required; pass --set ${key}=...`);
    }
  }
  writeOptions(pkg.id, options);
  return options;
}

// ---------------------------------------------------------------- agents
// Sources for every entry below: .plans/superhooks/research/<agent>.md in the jev-jam repo
// (each agent's official hook docs, fetched 2026-09-24).

/**
 * @typedef {"settings" | "file-per-package" | "amp-plugin"} WriterKind
 * @typedef {"json" | "plain"} OutputStyle
 * @typedef {{
 *   id: string, name: string,
 *   detect: string[],                      // any existing path means the agent is installed
 *   writer: WriterKind,
 *   file: string,                          // settings file, or per-package file (with {pkg})
 *   wrapperKey: string | null,             // key holding the event map inside `file`, if any
 *   events: Record<string, string>,        // Claude event -> native event
 *   tools: Record<string, string[]>,       // Claude tool -> native tool names (first is canonical)
 *   nativeMatchers: boolean,               // does the agent filter by matcher itself?
 *   output: OutputStyle,
 *   mcp?: "kiro" | "gemini",               // MCP tool naming, when not Claude's mcp__server__tool
 *   timeUnit?: "ms",                       // hook timeout unit, when not seconds
 *   notes?: string,                        // shown after install
 * }} Agent
 */

const PORTABLE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
/** @param {string[]} names */
const same = (names) => Object.fromEntries(names.map((name) => [name, name]));

/** @type {Record<string, Agent>} */
export const AGENTS = {
  claude: {
    id: "claude", name: "Claude Code", detect: ["~/.claude"],
    writer: "settings", file: "~/.claude/settings.json", wrapperKey: "hooks",
    events: same([...PORTABLE_EVENTS, "SubagentStop", "PreCompact", "SessionEnd", "Notification"]),
    tools: {}, nativeMatchers: true, output: "json",
  },
  codex: {
    id: "codex", name: "Codex", detect: ["~/.codex"],
    writer: "settings", file: "~/.codex/hooks.json", wrapperKey: "hooks",
    events: same([...PORTABLE_EVENTS, "SubagentStop", "PreCompact", "SessionEnd"]),
    // Codex matchers accept Claude's Edit/Write as aliases of apply_patch; reads and searches
    // run through Bash, so Read/Grep/Glob have no hookable equivalent.
    tools: { Bash: ["Bash"], Edit: ["apply_patch"], Write: ["apply_patch"], Task: ["spawn_agent"] },
    nativeMatchers: true, output: "json",
    notes: "Codex runs new hooks only after you trust them: open Codex and run /hooks.",
  },
  gemini: {
    id: "gemini", name: "Gemini CLI", detect: ["~/.gemini"],
    writer: "settings", file: "~/.gemini/settings.json", wrapperKey: "hooks",
    events: { SessionStart: "SessionStart", UserPromptSubmit: "BeforeAgent", PreToolUse: "BeforeTool",
      PostToolUse: "AfterTool", Stop: "AfterAgent", PreCompact: "PreCompress", SessionEnd: "SessionEnd",
      Notification: "Notification" },
    tools: { Bash: ["run_shell_command"], Read: ["read_file"], Write: ["write_file"], Edit: ["replace"],
      Grep: ["grep_search", "search_file_content"], Glob: ["glob"], WebFetch: ["web_fetch"],
      WebSearch: ["google_web_search"], TodoWrite: ["write_todos"] },
    nativeMatchers: true, output: "json", mcp: "gemini", timeUnit: "ms",
  },
  factory: {
    id: "factory", name: "Factory Droid", detect: ["~/.factory"],
    writer: "settings", file: "~/.factory/hooks.json", wrapperKey: null,
    events: same([...PORTABLE_EVENTS, "SubagentStop", "PreCompact", "SessionEnd", "Notification"]),
    tools: { Bash: ["Execute"], Read: ["Read"], Edit: ["Edit", "ApplyPatch"], Write: ["Create", "ApplyPatch"],
      Glob: ["Glob"], Grep: ["Grep"], Task: ["Task"], WebFetch: ["FetchUrl"], WebSearch: ["WebSearch"] },
    nativeMatchers: true, output: "json",
  },
  devin: {
    id: "devin", name: "Devin CLI", detect: ["~/.config/devin"],
    writer: "settings", file: "~/.config/devin/config.json", wrapperKey: "hooks",
    events: same([...PORTABLE_EVENTS, "SessionEnd"]),
    tools: { Bash: ["exec"], Read: ["read"], Write: ["write", "apply_patch"], Edit: ["edit", "apply_patch"],
      Grep: ["grep"], Glob: ["glob"], WebFetch: ["webfetch"], TodoWrite: ["todo_write"], Skill: ["skill"],
      Task: ["run_subagent"], NotebookEdit: ["notebook_edit"] },
    nativeMatchers: true, output: "json",
  },
  copilot: {
    id: "copilot", name: "GitHub Copilot (VS Code agent, Copilot CLI)", detect: ["~/.copilot"],
    writer: "file-per-package", file: "~/.copilot/hooks/superhooks-{pkg}.json", wrapperKey: "hooks",
    events: same([...PORTABLE_EVENTS, "SubagentStop", "PreCompact"]),
    // VS Code doesn't publish hook tool names; these are its documented tool identifiers.
    tools: { Bash: ["runInTerminal", "bash"], Read: ["readFile", "view"], Write: ["createFile", "create"],
      Edit: ["editFiles", "edit"], Grep: ["textSearch", "grep"], Glob: ["fileSearch", "glob"], WebFetch: ["fetch", "web_fetch"] },
    nativeMatchers: false, output: "json",
    notes: "VS Code doesn't document prompt-time context for UserPromptSubmit; tool hooks work.",
  },
  kiro: {
    id: "kiro", name: "Kiro", detect: ["~/.kiro"],
    writer: "file-per-package", file: "~/.kiro/hooks/superhooks-{pkg}.json", wrapperKey: null,
    events: same(PORTABLE_EVENTS),
    tools: { Bash: ["execute_bash", "shell", "execute_cmd"], Read: ["read_file", "read_files", "fs_read", "read"],
      Write: ["fs_write", "write"], Edit: ["str_replace"], Grep: ["grep_search", "grep"],
      Glob: ["file_search", "glob"], WebFetch: ["web_fetch"], WebSearch: ["web_search"] },
    nativeMatchers: true, output: "plain", mcp: "kiro",
  },
  amp: {
    id: "amp", name: "Amp", detect: ["~/.config/amp"],
    writer: "amp-plugin", file: "~/.config/amp/plugins/superhooks-{pkg}.ts", wrapperKey: null,
    events: { SessionStart: "session.start", UserPromptSubmit: "agent.start", PreToolUse: "tool.call",
      PostToolUse: "tool.result", Stop: "agent.end" },
    tools: { Bash: ["shell_command"], Read: ["Read"], Write: ["create_file", "apply_patch"],
      Edit: ["edit_file", "apply_patch"], WebFetch: ["read_web_page"], WebSearch: ["web_search"] },
    nativeMatchers: false, output: "json",
    notes: "Reload Amp plugins (command palette: plugins: reload) to activate.",
  },
};

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse"]);

/** @param {Agent} agent */
export const isInstalled = (agent) => agent.detect.some((p) => fs.existsSync(expandHome(p)));

/** MCP tool names: Claude `mcp__server__tool`, Kiro `@server/tool`, Gemini `mcp_server_tool`. */
function mcpToNative(/** @type {Agent} */ agent, /** @type {string} */ claudeName) {
  const [server, ...tool] = claudeName.slice(5).split("__");
  if (agent.mcp === "kiro") return `@${server}/${tool.join("__")}`;
  if (agent.mcp === "gemini") return `mcp_${server}_${tool.join("__")}`;
  return claudeName;
}

function nativeToolToClaude(/** @type {Agent} */ agent, /** @type {string} */ native) {
  if (agent.mcp === "kiro" && native.startsWith("@")) return [`mcp__${native.slice(1).replace("/", "__")}`];
  // Gemini: mcp_<server>_<tool>. Server names may contain "_", so this split is best-effort.
  if (agent.mcp === "gemini" && native.startsWith("mcp_") && !native.startsWith("mcp__")) {
    return [`mcp__${native.slice(4).replace("_", "__")}`];
  }
  const names = Object.entries(agent.tools).filter(([, natives]) => natives.includes(native)).map(([claude]) => claude);
  return names.length ? names : [native]; // unmapped names (e.g. identical MCP names) pass through
}

/**
 * Claude matcher semantics: empty/"*" = all; letters, digits, `_`, `-`, spaces, `,` and `|`
 * = exact list; anything else = unanchored regex.
 * @param {string} matcher @param {string[]} candidates Claude tool names for this call
 */
export function claudeMatcherMatches(matcher, candidates) {
  if (!matcher || matcher === "*") return true;
  if (/^[A-Za-z0-9_|, -]+$/.test(matcher)) {
    const allowed = matcher.split(/[|,]/).map((token) => token.trim()).filter(Boolean);
    return candidates.some((name) => allowed.includes(name));
  }
  try {
    const pattern = new RegExp(matcher);
    return candidates.some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

/**
 * The native matcher for an agent, or why the hook can't run there.
 * Regex matchers aren't translated: the native entry matches everything and the shim filters.
 * @param {Agent} agent @param {string} event @param {string} matcher
 * @returns {{ matcher?: string, skip?: string }}
 */
export function translateMatcher(agent, event, matcher) {
  if (!TOOL_EVENTS.has(event)) return ["claude", "codex", "factory"].includes(agent.id) ? { matcher } : {};
  if (!matcher || matcher === "*" || !/^[A-Za-z0-9_|, -]+$/.test(matcher) || agent.id === "claude") {
    return agent.id === "claude" ? { matcher } : {};
  }
  const tokens = matcher.split(/[|,]/).map((token) => token.trim()).filter(Boolean);
  const natives = new Set();
  for (const token of tokens) {
    if (token.startsWith("mcp__")) natives.add(mcpToNative(agent, token));
    else if (agent.tools[token]) agent.tools[token].forEach((name) => natives.add(name));
  }
  if (!natives.size) return { skip: `${agent.name} has no equivalent of tool matcher "${matcher}"` };
  return agent.nativeMatchers ? { matcher: [...natives].join("|") } : {};
}

/**
 * Native stdin -> Claude stdin. Field names already match Claude on every JSON agent; what
 * differs is the event name, tool names, and a few event-specific fields.
 * @param {Agent} agent @param {string} event @param {Record<string, any>} native
 */
export function toClaude(agent, event, native) {
  const payload = { ...native, hook_event_name: event };
  if (typeof native.tool_name === "string") payload.tool_name = nativeToolToClaude(agent, native.tool_name)[0];
  if (event === "Stop" && payload.last_assistant_message === undefined) {
    const last = native.assistant_response ?? native.prompt_response; // Kiro's and Gemini's names
    if (last !== undefined) payload.last_assistant_message = last;
  }
  if (payload.stop_hook_active === undefined && event === "Stop") payload.stop_hook_active = false;
  return payload;
}

/**
 * Claude result -> native result. JSON agents get Claude's JSON with the native event name;
 * plain text on context events is wrapped as additionalContext (not every agent reads plain
 * text). Kiro gets plain stdout for context and exit 2 for blocks, because any other
 * non-zero exit also blocks in the Kiro IDE.
 * @param {Agent} agent @param {string} event @param {HookResult} result @returns {HookResult}
 */
export function fromClaude(agent, event, result) {
  const text = result.stdout.trim();
  /** @type {any} */ let json = null;
  if (text.startsWith("{") && text.endsWith("}")) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  if (!json && text && CONTEXT_EVENTS.has(event)) {
    json = { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  }
  if (agent.output === "plain") return toPlain(event, json, text, result);
  if (agent.id === "gemini" && event === "PreToolUse" && json?.hookSpecificOutput) json = toGeminiToolDecision(json);
  if (json?.hookSpecificOutput) json.hookSpecificOutput.hookEventName = agent.events[event] || event;
  const exitCode = result.exitCode === 0 || result.exitCode === 2 ? result.exitCode : 0; // other failures never block
  return { stdout: json ? JSON.stringify(json) : "", stderr: result.stderr, exitCode };
}

/** Gemini's BeforeTool uses top-level decision/reason and hookSpecificOutput.tool_input. @param {any} json */
function toGeminiToolDecision(json) {
  const { permissionDecision, permissionDecisionReason, updatedInput, ...rest } = json.hookSpecificOutput;
  const out = { ...json, hookSpecificOutput: { ...rest, ...(updatedInput ? { tool_input: updatedInput } : {}) } };
  if (permissionDecision === "deny") Object.assign(out, { decision: "deny", reason: permissionDecisionReason || json.reason });
  return out;
}

/** @param {string} event @param {any} json @param {string} text @param {HookResult} result @returns {HookResult} */
function toPlain(event, json, text, result) {
  const specific = json?.hookSpecificOutput || {};
  const reason = json?.reason || specific.permissionDecisionReason || json?.stopReason || result.stderr;
  const blocked = result.exitCode === 2 || json?.decision === "block" || specific.permissionDecision === "deny" || json?.continue === false;
  if (blocked && event === "Stop") return { stdout: JSON.stringify({ decision: "block", reason }), stderr: "", exitCode: 0 };
  if (blocked) return { stdout: "", stderr: reason || "Blocked by hook", exitCode: 2 };
  return { stdout: specific.additionalContext || (json ? "" : text), stderr: result.stderr, exitCode: 0 };
}

// ---------------------------------------------------------------- writers

/** Marker every written command carries, so removal finds exactly our entries. @param {string} agentId @param {string} id */
const marker = (agentId, id) => ` run ${agentId} ${id} `;

/** `node <cli> run <agent> <pkg> <event> <index>` with a node path GUI-launched agents can find. */
function shimCommand(/** @type {string} */ agentId, /** @type {string} */ id, /** @type {string} */ event, /** @type {number} */ index) {
  let node = "node";
  try { node = fs.realpathSync(process.execPath); } catch { /* keep "node" */ }
  const quote = (/** @type {string} */ value) => (SHELL_SAFE_PATTERN.test(value) ? value : JSON.stringify(value));
  return `${quote(node)} ${quote(STABLE_CLI)}${marker(agentId, id)}${event} ${index}`;
}

/**
 * Translate a package's hooks for one agent.
 * @param {Agent} agent @param {Package} pkg
 * @returns {{ entries: Array<{ event: string, native: string, matcher?: string, command: string, timeout: number, index: number }>, skipped: string[] }}
 */
export function planForAgent(agent, pkg) {
  const entries = [];
  const skipped = [];
  for (const { event, index, matcher, hook } of listCommands(pkg.hooks)) {
    const native = agent.events[event];
    if (!native) { skipped.push(`${event}: no equivalent event in ${agent.name}`); continue; }
    if (hook.type !== "command") { skipped.push(`${event}: "${hook.type}" hooks are Claude-only`); continue; }
    const translated = translateMatcher(agent, event, matcher);
    if (translated.skip) { skipped.push(`${event}: ${translated.skip}`); continue; }
    const seconds = (/** @type {ClaudeCommandHook} */ (hook).timeout || DEFAULT_TIMEOUT_SECONDS) + TIMEOUT_HEADROOM_SECONDS;
    const timeout = agent.timeUnit === "ms" ? seconds * 1000 : seconds;
    entries.push({ event, native, matcher: translated.matcher, command: shimCommand(agent.id, pkg.id, event, index), timeout, index });
  }
  return { entries, skipped };
}

/** Remove our entries for (agent, pkg) from a Claude-shaped event map. @param {Record<string, any[]>} events @param {string} tag */
function stripEntries(events, tag) {
  for (const [event, groups] of Object.entries(events)) {
    const kept = (groups || [])
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((/** @type {any} */ h) => !String(h.command || "").includes(tag)) }))
      .filter((group) => group.hooks.length);
    if (kept.length) events[event] = kept;
    else delete events[event];
  }
}

/**
 * Write (or, with no entries, remove) an agent's config for one package.
 * @param {Agent} agent @param {Package} pkg @param {ReturnType<typeof planForAgent>["entries"]} entries
 * @returns {string} the file touched
 */
export function writeAgent(agent, pkg, entries) {
  const file = expandHome(agent.file.replace("{pkg}", pkg.id.replace("/", "__")));
  if (agent.writer === "settings") {
    const settings = readJson(file, {});
    const events = agent.wrapperKey ? (settings[agent.wrapperKey] ||= {}) : settings;
    stripEntries(events, marker(agent.id, pkg.id));
    for (const entry of entries) {
      const group = { ...(entry.matcher ? { matcher: entry.matcher } : {}),
        hooks: [{ type: "command", command: entry.command, timeout: entry.timeout }] };
      (events[entry.native] ||= []).push(group);
    }
    if (agent.wrapperKey && !Object.keys(events).length) delete settings[agent.wrapperKey];
    backupOnce(file);
    writeJson(file, settings);
    return file;
  }
  if (!entries.length) {
    fs.rmSync(file, { force: true });
    return file;
  }
  if (agent.writer === "amp-plugin") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ampPlugin(pkg, entries));
    return file;
  }
  if (agent.id === "kiro") {
    writeJson(file, { version: "v1", hooks: entries.map((entry) => ({
      name: `${pkg.name}: ${entry.event} #${entry.index}`, trigger: entry.native,
      ...(entry.matcher ? { matcher: entry.matcher } : {}),
      action: { type: "command", command: entry.command }, timeout: entry.timeout })) });
    return file;
  }
  /** @type {Record<string, any[]>} */ const events = {};
  for (const entry of entries) (events[entry.native] ||= []).push({ type: "command", command: entry.command, timeout: entry.timeout });
  writeJson(file, { hooks: events });
  return file;
}

/**
 * Amp has no hook config, only TypeScript plugins run by Bun. This generated plugin forwards
 * each event to the shim as Claude-format JSON and maps the Claude result to Amp's return values.
 * @param {Package} pkg @param {ReturnType<typeof planForAgent>["entries"]} entries
 */
function ampPlugin(pkg, entries) {
  const byEvent = /** @type {Record<string, string[]>} */ ({});
  for (const entry of entries) (byEvent[entry.native] ||= []).push(entry.command);
  return `// Generated by superhooks for ${pkg.id}. Do not edit: \`superhooks remove ${pkg.id}\` deletes it.
import type { PluginAPI } from '@ampcode/plugin'
import { spawnSync } from 'node:child_process'

export const description = ${JSON.stringify(`superhooks: ${pkg.name}`)}
const COMMANDS: Record<string, string[]> = ${JSON.stringify(byEvent, null, 2)}

function run(event: string, payload: Record<string, unknown>) {
  const results = []
  for (const command of COMMANDS[event] ?? []) {
    const child = spawnSync(command, { shell: true, input: JSON.stringify(payload), encoding: 'utf8' })
    let json: any = {}
    try { json = JSON.parse(child.stdout || '{}') } catch {}
    results.push({ json, exitCode: child.status ?? 0, stderr: child.stderr || '' })
  }
  return results
}

export default function (amp: PluginAPI) {
  const base = (event: any, ctx: any) => ({
    session_id: event.thread?.id,
    cwd: ctx.system?.workspaceRoot ? amp.helpers.filePathFromURI(ctx.system.workspaceRoot) : process.cwd(),
  })
  amp.on('session.start', async (event: any, ctx: any) => { run('session.start', base(event, ctx)) })
  amp.on('agent.start', async (event: any, ctx: any) => {
    const results = run('agent.start', { ...base(event, ctx), prompt: event.message })
    if (results.some((r) => r.exitCode === 2 || r.json.decision === 'block')) { await ctx.thread.cancel(); return }
    const context = results.map((r) => r.json.hookSpecificOutput?.additionalContext).filter(Boolean).join('\\n')
    return context ? { message: { content: context, display: false } } : undefined
  })
  amp.on('tool.call', async (event: any, ctx: any) => {
    for (const r of run('tool.call', { ...base(event, ctx), tool_name: event.tool, tool_input: event.input })) {
      const out = r.json.hookSpecificOutput ?? {}
      if (r.exitCode === 2 || out.permissionDecision === 'deny' || r.json.decision === 'block') {
        return { action: 'reject-and-continue', message: out.permissionDecisionReason || r.json.reason || r.stderr || 'Blocked by hook' }
      }
      if (out.updatedInput) return { action: 'modify', input: out.updatedInput }
    }
    return { action: 'allow' }
  })
  amp.on('tool.result', async (event: any, ctx: any) => {
    const results = run('tool.result', { ...base(event, ctx), tool_name: event.tool, tool_input: event.input,
      tool_response: event.output })
    const notes = results.map((r) => r.json.reason || r.json.hookSpecificOutput?.additionalContext).filter(Boolean)
    if (!notes.length) return undefined
    return { status: event.status, output: [event.output, ...notes].join('\\n') }
  })
  amp.on('agent.end', async (event: any, ctx: any) => {
    const results = run('agent.end', { ...base(event, ctx), last_assistant_message: event.message, stop_hook_active: false })
    const block = results.find((r) => r.exitCode === 2 || r.json.decision === 'block')
    return block ? { action: 'continue', userMessage: block.json.reason || block.stderr } : undefined
  })
}
`;
}

// ---------------------------------------------------------------- run (the shim)

/**
 * @typedef {{ stdout: string, stderr: string, exitCode: number }} HookResult
 */

/**
 * Execute one Claude-format command hook: Claude plugin env, stdin payload, timeout.
 * @param {ClaudeCommandHook} hook @param {Record<string, unknown>} payload @param {Record<string, string>} env
 * @returns {Promise<HookResult>}
 */
export function executeHook(hook, payload, env) {
  const timeoutMs = (hook.timeout || DEFAULT_TIMEOUT_SECONDS) * 1000;
  const child = hook.args
    ? spawn(hook.command, hook.args, { env }) // exec form: no shell, as in Claude Code
    : spawn(hook.command, { env, shell: true });
  /** @type {Buffer[]} */ const out = [];
  /** @type {Buffer[]} */ const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.stdin.on("error", () => {}); // a hook that ignores stdin must not crash us
  child.stdin.end(JSON.stringify(payload));
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (/** @type {number} */ exitCode) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode });
    };
    child.on("error", () => finish(1));
    child.on("close", (code, signal) => finish(signal ? 1 : code ?? 1));
  });
}

/**
 * The environment a Claude Code plugin hook expects, rebuilt for any agent.
 * @param {{ pluginRoot: string }} installed @param {string} id @param {string} agentId
 * @param {Record<string, unknown>} options @param {string} cwd
 */
export function pluginEnv(installed, id, agentId, options, cwd) {
  /** @type {Record<string, string>} */
  const env = { ...process.env };
  env.CLAUDE_PLUGIN_ROOT = installed.pluginRoot;
  env.CLAUDE_PLUGIN_DATA = path.join(STATE_DIR, "data", id.replace("/", "__"));
  env.CLAUDE_PROJECT_DIR = env.CLAUDE_PROJECT_DIR || cwd;
  env.SUPERHOOKS_AGENT = agentId; // lets a hook adapt, e.g. to a different transcript format
  for (const [key, value] of Object.entries(options)) {
    env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = String(value);
  }
  fs.mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true });
  return env;
}

/**
 * `superhooks run <agent> <package> <event> <index>`: called by agent configs.
 * Fails open: any superhooks error exits 0 with no output so the agent is never blocked.
 * @param {string[]} args
 */
async function runCommand(args) {
  const [agentId, id, event, indexText] = args;
  try {
    const agent = AGENTS[agentId];
    const installed = readJson(INSTALLED_FILE, {})[id];
    if (!agent || !installed) throw new Error(`unknown agent or package: ${agentId} ${id}`);
    const pkg = loadPackage(id, installed.source, installed.root, installed.plugin);
    const command = listCommands(pkg.hooks).find((c) => c.event === event && c.index === Number(indexText));
    if (!command || command.hook.type !== "command") throw new Error(`hook ${event}#${indexText} not found in ${id}`);

    // Devin also reads ~/.claude/settings.json; its own translated entry handles Devin.
    if (agentId === "claude" && process.env.DEVIN_PROJECT_DIR) return;
    const native = JSON.parse((await readStdin()) || "{}");
    // Apply the original Claude matcher here too: some agents (VS Code, Amp) have none, and
    // regex matchers aren't translated into native config.
    if (TOOL_EVENTS.has(event) && typeof native.tool_name === "string"
        && !claudeMatcherMatches(command.matcher, nativeToolToClaude(agent, native.tool_name))) return;
    const payload = toClaude(agent, event, native);
    const env = pluginEnv(installed, id, agentId, readOptions(id), String(payload.cwd || process.cwd()));
    const result = await executeHook(/** @type {ClaudeCommandHook} */ (command.hook), payload, env);
    const output = fromClaude(agent, event, result);
    if (output.stdout) process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  } catch (error) {
    logError(`run ${args.join(" ")}: ${/** @type {Error} */ (error).stack || error}`);
    process.exitCode = 0;
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  /** @type {Buffer[]} */ const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// ---------------------------------------------------------------- CLI

const USAGE = `superhooks ${VERSION} — install Claude Code hooks into every coding agent

  superhooks add <owner/repo | path> [--agents a,b] [--plugin name] [--set key=value]... [--yes]
  superhooks remove <package>
  superhooks list
  superhooks config <package> [key=value]...
  superhooks agents

Packages are Claude Code plugins (hooks/hooks.json + .claude-plugin/plugin.json).`;

/** @param {string[]} args */
function parseArgs(args) {
  /** @type {{ positional: string[], agents?: string[], plugin?: string, sets: Record<string, string>, yes: boolean }} */
  const parsed = { positional: [], sets: {}, yes: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--agents") parsed.agents = args[++i].split(",").map((a) => a.trim());
    else if (arg === "--plugin") parsed.plugin = args[++i];
    else if (arg === "--set") {
      const [key, ...value] = args[++i].split("=");
      parsed.sets[key] = value.join("=");
    } else if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else parsed.positional.push(arg);
  }
  return parsed;
}

/** Copy this CLI to a stable path; agent configs must not point into an npx cache. */
function installSelf() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const self = fileURLToPath(import.meta.url);
  if (path.resolve(self) !== path.resolve(STABLE_CLI)) fs.copyFileSync(self, STABLE_CLI);
}

/** Is this plugin already enabled natively in Claude Code? Then writing settings would double-fire. @param {Package} pkg */
function enabledAsClaudePlugin(pkg) {
  const enabled = readJson(path.join(HOME, ".claude", "settings.json"), {}).enabledPlugins || {};
  return Object.keys(enabled).some((key) => key.startsWith(`${pkg.name}@`) && enabled[key]);
}

/** @param {string[]} args */
async function addCommand(args) {
  const { positional, agents: only, plugin, sets, yes } = parseArgs(args);
  if (!positional[0]) throw new Error("usage: superhooks add <owner/repo | path>");
  const { id, root } = fetchPackage(positional[0]);
  const pkg = loadPackage(id, positional[0], root, plugin);
  await collectOptions(pkg, sets, !yes);
  installSelf();

  const installed = readJson(INSTALLED_FILE, {});
  const record = { source: positional[0], root, plugin, pluginRoot: pkg.pluginRoot, agents: /** @type {Record<string, string>} */ ({}) };
  console.log(`\n${pkg.name} (${id})`);
  for (const agent of Object.values(AGENTS)) {
    if (only ? !only.includes(agent.id) : !isInstalled(agent)) continue;
    if (agent.id === "claude" && enabledAsClaudePlugin(pkg)) {
      console.log(`  - ${agent.name}: already installed as a Claude Code plugin, skipped`);
      continue;
    }
    const { entries, skipped } = planForAgent(agent, pkg);
    let file = "";
    try {
      file = writeAgent(agent, pkg, entries);
    } catch (error) {
      console.log(`  ✗ ${agent.name}: ${/** @type {Error} */ (error).message}`);
      continue;
    }
    if (entries.length) record.agents[agent.id] = file;
    const events = [...new Set(entries.map((e) => e.native))].join(", ");
    console.log(entries.length ? `  ✓ ${agent.name}: ${events}  (${file.replace(HOME, "~")})` : `  - ${agent.name}: nothing to install`);
    for (const reason of skipped) console.log(`      skipped ${reason}`);
    if (entries.length && agent.notes) console.log(`      note: ${agent.notes}`);
  }
  installed[id] = record;
  writeJson(INSTALLED_FILE, installed);
}

/** @param {string[]} args */
function removeCommand(args) {
  const id = args[0];
  const installed = readJson(INSTALLED_FILE, {});
  const record = installed[id];
  if (!record) throw new Error(`${id} isn't installed (see: superhooks list)`);
  const pkg = /** @type {Package} */ ({ id, name: id, hooks: {}, userConfig: {}, source: record.source, root: record.root, pluginRoot: record.pluginRoot });
  for (const agentId of Object.keys(record.agents)) {
    writeAgent(AGENTS[agentId], pkg, []);
    console.log(`  ✓ removed from ${AGENTS[agentId].name}`);
  }
  delete installed[id];
  writeJson(INSTALLED_FILE, installed);
  if (record.root.startsWith(path.join(STATE_DIR, "packages"))) fs.rmSync(record.root, { recursive: true, force: true });
  fs.rmSync(optionsFile(id), { force: true });
}

function listCommand() {
  const installed = readJson(INSTALLED_FILE, {});
  if (!Object.keys(installed).length) return console.log("No packages installed.");
  for (const [id, record] of Object.entries(installed)) {
    console.log(`${id}  →  ${Object.keys(record.agents).map((a) => AGENTS[a]?.name || a).join(", ") || "no agents"}`);
  }
}

/** @param {string[]} args */
async function configCommand(args) {
  const [id, ...pairs] = args;
  const record = readJson(INSTALLED_FILE, {})[id];
  if (!record) throw new Error(`${id} isn't installed (see: superhooks list)`);
  const pkg = loadPackage(id, record.source, record.root, record.plugin);
  if (!pairs.length) {
    const options = readOptions(id);
    for (const [key, field] of Object.entries(pkg.userConfig)) {
      const value = key in options ? (field.sensitive ? "(set)" : JSON.stringify(options[key])) : "(unset)";
      console.log(`${key} = ${value}   ${field.description || ""}`);
    }
    return;
  }
  const sets = Object.fromEntries(pairs.map((pair) => { const [k, ...v] = pair.split("="); return [k, v.join("=")]; }));
  for (const key of Object.keys(sets)) if (!(key in pkg.userConfig)) throw new Error(`unknown option "${key}"`);
  await collectOptions(pkg, sets, false);
  console.log("Saved. Takes effect on the next hook run.");
}

function agentsCommand() {
  for (const agent of Object.values(AGENTS)) {
    console.log(`${isInstalled(agent) ? "✓" : " "} ${agent.id.padEnd(8)} ${agent.name}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "run") return runCommand(args);
  try {
    if (command === "add") await addCommand(args);
    else if (command === "remove") removeCommand(args);
    else if (command === "list") listCommand();
    else if (command === "config") await configCommand(args);
    else if (command === "agents") agentsCommand();
    else if (command === "--version" || command === "-v") console.log(VERSION);
    else console.log(USAGE);
  } catch (error) {
    console.error(`superhooks: ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
