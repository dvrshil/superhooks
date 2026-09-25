# superhooks

Write a hook once, as a Claude Code hook, and run it in every coding agent.

```bash
npx superhooks add owner/repo
```

This installs a Claude Code plugin's hooks into every agent on your machine: Claude Code, Codex,
Gemini CLI, Qwen Code, Factory Droid, Devin CLI, GitHub Copilot (VS Code agent and Copilot CLI),
Kiro and Amp. Each agent gets hooks in its own native format, and the hook script runs unchanged.

## Why

Most coding agents now have hooks, and most of them copied Claude Code's design: the same
`UserPromptSubmit` and `PreToolUse` events, JSON on stdin, and
`hookSpecificOutput.additionalContext` out. But each one differs in small ways: event names
(`BeforeAgent`), tool names (`Execute`, `run_shell_command`), config files, timeout units (Gemini
uses milliseconds), exit-code rules, and whether plain-text output counts. Plugin options and
secrets exist only in Claude Code. superhooks handles all of that, so a hook author targets one
format.

## Use a hook

```bash
npx superhooks add dvrshil/jev-skill-router-prehook   # asks for the plugin's options, installs everywhere
npx superhooks list                                   # what's installed, and where
npx superhooks config dvrshil/jev-skill-router-prehook max_suggestions=3
npx superhooks remove dvrshil/jev-skill-router-prehook
npx superhooks agents                                 # which agents were detected
```

- **Pick agents:** `--agents codex,gemini`.
- **Set options without prompts:** `--set key=value` and `--yes`.
- **Choose a plugin:** `--plugin name` when a repo lists several.
- **Local packages:** a local path works too and is used in place, which is handy while
  developing a hook.

**One manual step per agent, where required:**
- **Codex** runs a new hook only after you trust it: open Codex and run `/hooks`.
- **Amp:** reload plugins (command palette → `plugins: reload`).

## Write a hook

Any Claude Code plugin with hooks is already a superhooks package: `hooks/hooks.json` plus an
optional `.claude-plugin/plugin.json`. A repo with `.claude-plugin/marketplace.json` works as well.

- **Options:** `userConfig` options are asked for once at install time. Secrets are stored in
  `~/.superhooks/config/`, readable only by you, and reach your hook as
  `CLAUDE_PLUGIN_OPTION_<KEY>`, as in Claude Code.
- **Environment:** `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` work in every agent.
- **Which agent is running:** `SUPERHOOKS_AGENT` tells your hook the host, e.g. to scan that
  agent's skill folders.
- **Portable events:** `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`.
  Others are installed where an agent has an equivalent, and skipped with a message elsewhere.
- **Hook types:** only `command` hooks are portable; `prompt`, `agent`, `http` and `mcp_tool` are
  Claude-only.

## How it works

`add` writes one entry per hook into each agent's config. Every entry calls the superhooks shim,
which:

1. **Reads stdin:** takes the agent's native input and converts it to Claude's (event name, tool
   names, a few event-specific fields).
2. **Filters:** applies the hook's original Claude matcher. VS Code and Amp have no matchers, and
   regex matchers aren't translated into native config.
3. **Runs the hook:** starts the command with the Claude plugin environment and its timeout.
4. **Converts the output:** turns Claude's output into what the agent expects. Gemini gets
   `decision: "deny"`, Kiro gets plain text and exit code 2, and plain text becomes
   `additionalContext` where an agent only reads JSON.

The shim **fails open**: if superhooks itself breaks, your agent carries on with no output. Other
non-zero exit codes from a hook are treated as non-blocking everywhere, as in Claude Code; this
matters in Kiro's IDE, which would otherwise block on them.

**Written files, and how `remove` undoes them:**
- **Shared config files:** Claude, Codex, Gemini, Qwen, Factory and Devin config files get entries
  merged in. A one-time `*.superhooks.bak` backup is kept, and `remove` deletes only the entries
  superhooks added.
- **Separate files:** Copilot and Kiro each get a file of their own, and Amp gets a generated
  TypeScript plugin. `remove` deletes those files.

## Agent support

| Agent | Config written | Adds prompt-time context | Notes |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | ✅ | Skipped if the plugin is already installed natively |
| Codex | `~/.codex/hooks.json` | ✅ tested end to end | Trust once with `/hooks`. `Read`/`Grep`/`Glob` run through `Bash` in Codex, so those matchers are skipped |
| Gemini CLI | `~/.gemini/settings.json` | ✅ | `BeforeAgent`/`BeforeTool`/`AfterTool`/`AfterAgent`; millisecond timeouts |
| Qwen Code | `~/.qwen/settings.json` | ✅ | Claude event names and matchers |
| Factory Droid | `~/.factory/hooks.json` | ✅ | |
| Devin CLI | `~/.config/devin/config.json` | ✅ | Devin also reads `~/.claude/settings.json`; the Claude entry stands down there to avoid double runs |
| Copilot (VS Code agent, CLI) | `~/.copilot/hooks/superhooks-*.json` | ⚠️ not documented for `UserPromptSubmit` | Tool hooks work; VS Code tool names are best-effort |
| Kiro (IDE, CLI) | `~/.kiro/hooks/superhooks-*.json` | ✅ plain text | |
| Amp | `~/.config/amp/plugins/superhooks-*.ts` | ✅ | Generated plugin; reload plugins after install |

**Not supported, because they have no prompt-time hook that can add context:** Cursor, Windsurf,
Augment and Devin (cloud). Their tool-level hooks may still be worth adding later.

## Publishing a hook

- **Everywhere, with full translation:** push your Claude Code plugin to GitHub and tell users
  `npx superhooks add you/repo`.
- **Native plugin systems, same repo:** Claude Code, Codex and Factory install a Claude
  marketplace repo directly (`… marketplace add you/repo`).
  - Hooks run untranslated in native installs, so write matchers with the agent's tool names or
    handle them in your script.
  - `userConfig` options aren't collected outside Claude Code, so accept them from env vars too.

## Limits

- Requires Node 18+ on your PATH.
- Tested end to end with Claude Code's format and with real Codex runs. The other agents are built
  from their current docs and covered by translation tests; please report any mismatches.
- Transcript formats differ across agents; `transcript_path` is passed through as-is.

## Development

```bash
npm test          # node:test, no dependencies, no network
```

Agents are data: see `AGENTS` in `superhooks.mjs`. Adding an agent means adding one table entry,
plus output translation if its format differs.

MIT licensed.
