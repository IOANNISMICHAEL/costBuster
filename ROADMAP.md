# Roadmap

## v1 (current)

- Local-only dashboard for Anthropic + OpenAI usage
- Anthropic parser: Claude Code JSONL files (`~/.claude/projects/**/*.jsonl`)
- OpenAI parser: API response JSONL, platform CSV export, JSON array
- Interactive charts: daily cost bar chart, cost-by-model doughnut (Chart.js)
- Summary cards with sparkline trends (last 7 days)
- Breakdowns: by day, by model, by project, by session
- Date range filter and provider toggle
- Sortable table columns (click header to sort asc/desc)
- Instant text search/filter on all tables
- CSV export of all filtered records
- Insights: provider split, top model, most expensive model, cache usage, cache savings estimate
- Top expensive prompts (Anthropic only, where snippet is available)
- Dark/light theme with system preference detection
- CLI: `--port`, `--no-open`, `--anthropic-dir`, `--openai-file`, `--openai-dir`
- Cursor IDE investigated: no token data in transcripts (deferred)

## v1.1 (planned)

- Anthropic `_cost.json` file support
- Collapsible table sections
- Per-session drill-down view

## v2 (future)

- Additional provider parsers (Google AI, Cohere, etc.)
- Persistent local SQLite storage for historical tracking
- Cost alerts / budget thresholds
- Multi-user support (separate data dirs)
