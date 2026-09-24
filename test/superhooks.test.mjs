// Run: npm test   (node:test, no dependencies, no network)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENTS, claudeMatcherMatches, fromClaude, listCommands, planForAgent, toClaude, translateMatcher, writeAgent,
} from "../superhooks.mjs";

const CLI = fileURLToPath(new URL("../superhooks.mjs", import.meta.url));

/** A tiny Claude Code plugin whose hooks echo what they received, for end-to-end runs. */
function makePlugin(root) {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: "echo-hint",
    userConfig: { greeting: { type: "string", title: "Greeting", description: "d", default: "hi" } },
  }));
  const script = path.join(root, "hooks", "echo.mjs");
  fs.writeFileSync(script, `
    let input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => {
      const p = JSON.parse(input);
      if (p.hook_event_name === "PreToolUse") {
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no " + p.tool_name } }));
        return;
      }
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: p.hook_event_name,
        additionalContext: [process.env.CLAUDE_PLUGIN_OPTION_GREETING, p.prompt, process.env.SUPERHOOKS_AGENT,
          path.basename(process.env.CLAUDE_PLUGIN_ROOT)].join("|") } }));
    });
    import path from "node:path";`);
  fs.writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/echo.mjs"' }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/echo.mjs"' }] }],
    Notification: [{ hooks: [{ type: "prompt", prompt: "x" }] }],
  } }));
  return root;
}

const pkg = (hooks) => ({ id: "me/pkg", name: "pkg", source: "me/pkg", root: "/r", pluginRoot: "/r", hooks, userConfig: {} });

test("Claude matcher semantics: exact lists and unanchored regex", () => {
  assert.ok(claudeMatcherMatches("", ["Bash"]));
  assert.ok(claudeMatcherMatches("Edit|Write", ["Write"]));
  assert.ok(!claudeMatcherMatches("Edit|Write", ["Bash"]));
  assert.ok(claudeMatcherMatches("mcp__.*", ["mcp__github__create_issue"]));
  assert.ok(!claudeMatcherMatches("Edit", ["NotebookEdit"])); // exact list, not substring
  assert.ok(claudeMatcherMatches("Edit.*", ["Edit"]));
});

test("matchers translate to native tool names, or skip when nothing maps", () => {
  assert.deepEqual(translateMatcher(AGENTS.factory, "PreToolUse", "Bash|Write"), { matcher: "Execute|Create|ApplyPatch" });
  assert.deepEqual(translateMatcher(AGENTS.kiro, "PreToolUse", "mcp__db__query"), { matcher: "@db/query" });
  assert.deepEqual(translateMatcher(AGENTS.gemini, "PreToolUse", "Bash|mcp__db__query"), { matcher: "run_shell_command|mcp_db_query" });
  assert.ok(translateMatcher(AGENTS.codex, "PreToolUse", "Read").skip);
  assert.deepEqual(translateMatcher(AGENTS.copilot, "PreToolUse", "Bash"), {}); // no native matchers: the shim filters
  assert.deepEqual(translateMatcher(AGENTS.devin, "PreToolUse", "Edit.*"), {}); // regex: the shim filters
});

test("planForAgent maps events, drops unsupported ones, and explains why", () => {
  const hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "x" }] }],
    Notification: [{ hooks: [{ type: "command", command: "y" }] }], Stop: [{ hooks: [{ type: "prompt" }] }] };
  const { entries, skipped } = planForAgent(AGENTS.amp, pkg(hooks));
  assert.deepEqual(entries.map((e) => e.native), ["agent.start"]);
  assert.equal(skipped.length, 2);
  assert.match(entries[0].command, / run amp me\/pkg UserPromptSubmit 0$/);
});

test("stdin translation: native tool names and Kiro's stop field become Claude's", () => {
  assert.equal(toClaude(AGENTS.factory, "PreToolUse", { tool_name: "Execute" }).tool_name, "Bash");
  assert.equal(toClaude(AGENTS.kiro, "PreToolUse", { tool_name: "@db/query" }).tool_name, "mcp__db__query");
  const stop = toClaude(AGENTS.kiro, "Stop", { hook_event_name: "stop", assistant_response: "done" });
  assert.equal(stop.hook_event_name, "Stop");
  assert.equal(stop.last_assistant_message, "done");
});

test("output translation: JSON agents, plain-text Kiro, and fail-open exit codes", () => {
  const context = { stdout: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"ctx"}}', stderr: "", exitCode: 0 };
  assert.equal(fromClaude(AGENTS.kiro, "UserPromptSubmit", context).stdout, "ctx");
  const plain = fromClaude(AGENTS.devin, "UserPromptSubmit", { stdout: "plain words", stderr: "", exitCode: 0 });
  assert.equal(JSON.parse(plain.stdout).hookSpecificOutput.additionalContext, "plain words");
  const deny = { stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"nope"}}', stderr: "", exitCode: 0 };
  assert.deepEqual(fromClaude(AGENTS.kiro, "PreToolUse", deny), { stdout: "", stderr: "nope", exitCode: 2 });
  assert.equal(fromClaude(AGENTS.kiro, "PreToolUse", { stdout: "", stderr: "boom", exitCode: 1 }).exitCode, 0);
  assert.equal(fromClaude(AGENTS.codex, "PreToolUse", { stdout: "", stderr: "boom", exitCode: 1 }).exitCode, 0);
  const gemini = JSON.parse(fromClaude(AGENTS.gemini, "PreToolUse", deny).stdout);
  assert.equal(gemini.decision, "deny");
  assert.equal(gemini.reason, "nope");
  assert.equal(gemini.hookSpecificOutput.hookEventName, "BeforeTool");
  assert.equal(JSON.parse(fromClaude(AGENTS.gemini, "UserPromptSubmit", context).stdout).hookSpecificOutput.hookEventName, "BeforeAgent");
  assert.equal(toClaude(AGENTS.gemini, "Stop", { prompt_response: "done" }).last_assistant_message, "done");
  assert.equal(toClaude(AGENTS.gemini, "PreToolUse", { tool_name: "mcp_db_query" }).tool_name, "mcp__db__query");
  const stop = fromClaude(AGENTS.kiro, "Stop", { stdout: '{"decision":"block","reason":"keep going"}', stderr: "", exitCode: 0 });
  assert.deepEqual(JSON.parse(stop.stdout), { decision: "block", reason: "keep going" });
});

test("settings writer merges, preserves the user's own hooks, and removes only ours", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sh-writer-"));
  const agent = { ...AGENTS.codex, file: path.join(home, "hooks.json") };
  fs.writeFileSync(agent.file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] }, other: 1 }));
  const p = pkg({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] });
  writeAgent(agent, p, planForAgent(agent, p).entries);
  writeAgent(agent, p, planForAgent(agent, p).entries); // idempotent: re-adding replaces, not duplicates
  let written = JSON.parse(fs.readFileSync(agent.file, "utf8"));
  assert.equal(written.hooks.Stop.length, 2);
  assert.equal(written.other, 1);
  assert.ok(fs.existsSync(`${agent.file}.superhooks.bak`));
  writeAgent(agent, p, []);
  written = JSON.parse(fs.readFileSync(agent.file, "utf8"));
  assert.deepEqual(written.hooks.Stop, [{ hooks: [{ type: "command", command: "mine" }] }]);
});

test("listCommands addresses each command by event and index", () => {
  const commands = listCommands({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] }] });
  assert.deepEqual(commands.map((c) => [c.event, c.index, c.matcher]), [["PreToolUse", 0, "Bash"], ["PreToolUse", 1, "Bash"]]);
});

test("end to end: add installs into every detected agent; the shim runs the Claude hook for each", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sh-home-"));
  const env = { ...process.env, HOME: home, SUPERHOOKS_HOME: path.join(home, ".superhooks") };
  for (const dir of [".claude", ".codex", ".gemini", ".factory", ".config/devin", ".copilot", ".kiro", ".config/amp"]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true });
  }
  const plugin = makePlugin(path.join(home, "echo-hint"));
  const add = spawnSync("node", [CLI, "add", plugin, "--set", "greeting=hello", "--yes"], { env, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Codex: UserPromptSubmit, PreToolUse/);
  assert.match(add.stdout, /skipped Notification/);
  const gemini = JSON.parse(fs.readFileSync(path.join(home, ".gemini/settings.json"), "utf8"));
  assert.equal(gemini.hooks.BeforeTool[0].matcher, "run_shell_command");
  assert.equal(gemini.hooks.BeforeAgent[0].hooks[0].timeout, 65000); // Gemini counts milliseconds

  const run = (agent, event, payload) => {
    const result = spawnSync("node", [path.join(home, ".superhooks", "superhooks.mjs"), "run", agent, "local/echo-hint", event, "0"],
      { env, input: JSON.stringify(payload), encoding: "utf8" });
    return result;
  };
  // Every JSON agent gets Claude-shaped context, with options and plugin root provided.
  for (const agent of ["claude", "codex", "gemini", "factory", "devin", "copilot"]) {
    const out = JSON.parse(run(agent, "UserPromptSubmit", { hook_event_name: "UserPromptSubmit", prompt: "yo" }).stdout);
    assert.equal(out.hookSpecificOutput.additionalContext, `hello|yo|${agent}|echo-hint`);
  }
  // Kiro gets plain text.
  assert.equal(run("kiro", "UserPromptSubmit", { hook_event_name: "userPromptSubmit", prompt: "yo" }).stdout.trim(), "hello|yo|kiro|echo-hint");
  // Tool hooks: Factory's Execute is Claude's Bash, so the Bash matcher fires and denies.
  const deny = JSON.parse(run("factory", "PreToolUse", { tool_name: "Execute", tool_input: {} }).stdout);
  assert.equal(deny.hookSpecificOutput.permissionDecisionReason, "no Bash");
  // The shim applies the Claude matcher itself: a Read on VS Code doesn't reach a Bash hook.
  assert.equal(run("copilot", "PreToolUse", { tool_name: "readFile", tool_input: {} }).stdout, "");
  // Kiro blocks through exit 2.
  const kiroDeny = run("kiro", "PreToolUse", { tool_name: "execute_bash", tool_input: {} });
  assert.equal(kiroDeny.status, 2);
  assert.equal(kiroDeny.stderr, "no Bash");
  // Devin reads ~/.claude/settings.json too; the Claude entry stands down inside Devin.
  const inDevin = spawnSync("node", [path.join(home, ".superhooks", "superhooks.mjs"), "run", "claude", "local/echo-hint", "UserPromptSubmit", "0"],
    { env: { ...env, DEVIN_PROJECT_DIR: home }, input: "{}", encoding: "utf8" });
  assert.equal(inDevin.stdout, "");
  // Unknown package: fail open, never block the agent.
  const broken = spawnSync("node", [path.join(home, ".superhooks", "superhooks.mjs"), "run", "codex", "nope/nope", "Stop", "0"],
    { env, input: "{}", encoding: "utf8" });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");

  const ampPlugin = fs.readFileSync(path.join(home, ".config/amp/plugins/superhooks-local__echo-hint.ts"), "utf8");
  assert.match(ampPlugin, /amp\.on\('agent\.start'/);

  const remove = spawnSync("node", [CLI, "remove", "local/echo-hint"], { env, encoding: "utf8" });
  assert.equal(remove.status, 0, remove.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, ".codex/hooks.json"), "utf8")), {});
  assert.ok(!fs.existsSync(path.join(home, ".kiro/hooks/superhooks-local__echo-hint.json")));
});
