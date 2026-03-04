# CostBuster

Local dashboard for tracking your Anthropic and OpenAI API usage costs. Reads local logs, syncs with the Anthropic Usage & Cost Admin API, synchs with OpenAI keys, can read imported CSVs with usage data from Claude/openAi exports.

## Quick Start

```bash
npx costbuster
```

Or install globally:

```bash
npm install -g costbuster
costbuster
```

This starts a local server and opens the dashboard in your browser.

## What It Does

- **Anthropic Local:** Reads Claude Code usage from `~/.claude/projects/**/*.jsonl`
- **Anthropic API:** Syncs usage and cost from the [Anthropic Admin API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api) (organization accounts, requires Admin API key)
- **OpenAI:** Reads OpenAI usage from a file or directory you specify
- Interactive charts: daily cost bar chart, cost-by-model doughnut
- Summary cards with sparkline trends
- Breakdowns by day, model, project, session, and provider
- Separate "Anthropic Local" and "Anthropic API" views with top-level filter chips
- Date range filter and provider toggle
- Sortable table columns and instant text search
- Multi-key support — add as many Anthropic Admin API keys as you need
- Configurable sync window (1–365 days of API history)
- Export all filtered records as CSV (includes API-specific fields)
- Generates insights (provider split, cache savings, top models)
- Lists top expensive prompts (where available)
- Dark/light theme with system preference detection

## Options

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | `3456` | Port to listen on |
| `--no-open` | — | Don't auto-open browser |
| `--anthropic-dir <path>` | `~/.claude` | Anthropic local data directory |
| `--anthropic-keys <keys>` | — | Comma-separated Anthropic Admin API keys |
| `--sync-days <n>` | `30` | Days of API history to fetch |
| `--openai-file <path>` | — | OpenAI usage file (CSV/JSON/JSONL) |
| `--openai-dir <path>` | — | Directory of OpenAI API response logs |
| `-h, --help` | — | Show help |

## Environment Variables

| Variable | Description |
|---|---|
| `COSTBUSTER_PORT` | Port (overridden by `--port`) |
| `COSTBUSTER_NO_OPEN` | Set to `1` to skip browser auto-open |
| `ANTHROPIC_DATA_DIR` | Anthropic local data directory |
| `ANTHROPIC_ADMIN_KEY` | Anthropic Admin API key (appended to saved keys) |
| `ANTHROPIC_SYNC_DAYS` | Days of API history to fetch |
| `OPENAI_USAGE_FILE` | Path to OpenAI usage file |
| `OPENAI_LOGS_DIR` | Path to OpenAI logs directory |

## Supported Data Sources

See [DATA_SOURCES.md](DATA_SOURCES.md) for detailed format documentation.

**Anthropic Local:** Claude Code conversation logs (JSONL) — auto-detected from `~/.claude`

**Anthropic API:** Live usage and cost data via the [Admin API](https://platform.claude.com/docs/en/build-with-claude/usage-cost-api). Requires an Admin API key (`sk-ant-admin...`) — available for organization accounts only. Add keys in Settings or via `--anthropic-keys` / `ANTHROPIC_ADMIN_KEY`.

**OpenAI:** API response logs (JSONL), platform CSV export, or JSON array — specify via `--openai-file` or `--openai-dir`

## Development

```bash
git clone https://github.com/IOANNISMICHAEL/costBuster.git
cd costbuster
npm install
npm start          # Start server
npm test           # Run tests
npm run dev        # Start with auto-reload (requires npx nodemon)
```

## License

MIT
