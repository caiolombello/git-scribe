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

Inside a git repository:

```
bun run src/cli.ts
```

Initialize config:

```
bun run src/cli.ts init
```

Flags:

```
--mode <single|manual|ai>
--dry-run
--hunks
--auto
--model <name>
--max-diff-chars <n>
```

Build:

```
bun run build
```

## Notes

- The tool stages files you select and commits with pathspecs to avoid touching other staged changes.
- AI grouping is best-effort; you can edit or redo groups.
