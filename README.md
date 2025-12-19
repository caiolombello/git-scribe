# git-scribe

Generate Conventional Commits messages with AI and optionally split large changes into multiple commits.

## Setup

- Requires Bun
- Set `OPENAI_API_KEY` or create `~/.config/git-scribe/config.json`
- Optional: `OPENAI_MODEL` (default: `gpt-5.1-codex-mini`)
- Optional: `OPENAI_BASE_URL` (default: `https://api.openai.com`)

Example config:

```
{
  "apiKey": "sk-...",
  "model": "gpt-5.1-codex-mini",
  "baseUrl": "https://api.openai.com"
}
```

## Usage

Inside a git repository (dev run):

```
bun run src/cli.ts
```

After install:

```
git-scribe
```

Initialize config:

```
bun run src/cli.ts init
```

Examples:

```
# Single commit with AI message
git-scribe --mode single

# Multiple commits, grouped by AI
git-scribe --mode ai

# Manual grouping
git-scribe --mode manual

# Stage by hunks (git add -p)
git-scribe --hunks

# Auto accept message + skip confirmations
git-scribe --auto --mode ai

# Preview only (no git add / commit)
git-scribe --dry-run
```

Flags:

```
--mode <single|manual|ai>
  Choose how to split commits.
--dry-run
  Show the suggested commit message without staging or committing.
--hunks
  Use interactive hunk selection (git add -p).
--auto
  Accept the suggested message and skip confirmations.
--model <name>
  Override the default model.
--max-diff-chars <n>
  Limit the diff sent to the model. Use 0 for no limit.
```

Build:

```
bun run build
```

## Makefile

Install to `~/.local/bin`:

```
make install
```

Uninstall:

```
make uninstall
```

Custom prefix:

```
make install PREFIX=/custom/path
```

## Notes

- The tool stages files you select and commits with pathspecs to avoid touching other staged changes.
- AI grouping is best-effort; you can edit or redo groups.
