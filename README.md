# Agent Sessions Manager

A command-line application for listing and converting AI coding-agent sessions.

## Current scope

Session listing and text-history conversion are supported between four clients:

- OpenAI Codex (`codex`)
- Pi (`pi`)
- OpenCode export JSON (`opencode`)
- Claude Code (`claude`)

The shared message model preserves user/assistant text, timestamps, model metadata where available, compaction summaries, and filters known Codex contextual prompts. It focuses on session text and compaction data rather than replaying tool calls/results, approval state, sandbox state, MCP events, or reasoning.

Conversions targeting Pi also write the default Pi DCP session-state file under `~/.pi-dcp`. The CLI uses each provider's default paths. Trace export, search/indexing, and MCP features are not implemented.

## Requirements

- Node.js 20+
- npm

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

## CLI

All paths default to the corresponding local application directory. Conversions write by default; use `--dry` with `convert` to preview without writing.

```sh
asm --help
asm list --help
asm convert --help
asm list codex
asm list codex --full-name
asm list claude --json
asm convert codex pi <session-id>
asm convert codex pi <session-id> --dry
asm convert opencode claude <session-id>
```

Each command has its own help and options. `--full-name` and `--json` apply to `list`; `--dry`, `-y`/`--yes`, and `--new-id` apply to `convert`.

`asm list <provider>` prints a provider heading with the session count, a blank line, then one line per session in `ID · date/time (message count) · title` format. Sessions are sorted newest first, dates use the system locale and timezone, and paths are omitted. Fallback titles use the first user message with text; Claude command metadata is stripped before checking. The title is truncated as needed so the row fits within the terminal width minus one column; truncated titles end in `…`. If the width cannot be detected, 80 columns are assumed. `--full-name` disables truncation.

`asm list <provider> --json` prints a JSON array of session summaries, without the terminal heading or title truncation. Each object contains `provider`, `sessionId`, `title`, `projectPath` (the working directory), `timestamp` (ISO 8601), `path` (the local session file), and `messageCount`.

If an output already exists, the CLI asks whether to replace it. Answer `y` or `yes` to continue; any other answer cancels. Use `-y` or `--yes` to automatically confirm interactive prompts, including file-overwrite confirmation; in non-interactive scripts it skips the prompt and overwrites existing outputs.

Session counts use provider-native message records rather than extracted text. Compaction records are included where they are stored separately.
