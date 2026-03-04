# Data Sources

CostBuster reads usage data from local files. No network requests are made to any API.

---

## Anthropic (Claude Code)

### Path

Default: `~/.claude`  
Override: `--anthropic-dir <path>` or env `ANTHROPIC_DATA_DIR`

The parser scans:
- `<dataDir>/projects/**/*.jsonl` — Claude Code conversation logs
- `<dataDir>/history.jsonl` — Global history (if present)

### File format: JSONL

Each line is a JSON object. CostBuster uses **`type: "assistant"`** lines only.

**Required fields** (on assistant lines):

| Field | Type | Description |
|---|---|---|
| `type` | `"assistant"` | Record type (user/assistant/queue-operation) |
| `timestamp` | ISO 8601 string | When the response was generated |
| `sessionId` | string | Conversation/session identifier |
| `message.model` | string | Model name (e.g. `claude-sonnet-4-20250514`) |
| `message.usage.input_tokens` | number | Prompt tokens |
| `message.usage.output_tokens` | number | Completion tokens |
| `message.usage.cache_creation_input_tokens` | number | Cache write tokens |
| `message.usage.cache_read_input_tokens` | number | Cache read tokens |
| `message.usage.cache_creation.ephemeral_5m_input_tokens` | number | 5-min ephemeral cache |
| `message.usage.cache_creation.ephemeral_1h_input_tokens` | number | 1-hr ephemeral cache |

**Skipped lines:**
- `type !== "assistant"` (user messages, queue operations)
- `message.model === "<synthetic>"` (local error stubs)
- Zero input AND output tokens

### Example line

```json
{
  "type": "assistant",
  "timestamp": "2025-11-07T18:05:33.971Z",
  "sessionId": "8773209b-9c13-4cde-988c-a722fb0b9441",
  "message": {
    "model": "claude-haiku-4-5-20251001",
    "usage": {
      "input_tokens": 502,
      "output_tokens": 142,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 0,
        "ephemeral_1h_input_tokens": 0
      }
    }
  }
}
```

---

## OpenAI

### Path

CostBuster supports two OpenAI input methods:

1. **Single file** (CSV, JSON, or JSONL):  
   `--openai-file <path>` or env `OPENAI_USAGE_FILE`

2. **Directory of API response logs** (JSON/JSONL):  
   `--openai-dir <path>` or env `OPENAI_LOGS_DIR`

Both can be used simultaneously.

### Format A: API Response Logs (JSONL)

Each line mirrors an OpenAI API `chat.completion` response.

| Field | Type | Description |
|---|---|---|
| `model` | string | Model name (e.g. `gpt-4o`) |
| `created` | number | Unix timestamp |
| `usage.prompt_tokens` | number | Input tokens |
| `usage.completion_tokens` | number | Output tokens |
| `usage.total_tokens` | number | Sum (optional) |
| `id` | string | Completion ID (used as sessionId) |

**Example:**

```json
{"id":"chatcmpl-abc123","object":"chat.completion","created":1700000000,"model":"gpt-4o","usage":{"prompt_tokens":1200,"completion_tokens":350,"total_tokens":1550}}
```

### Format B: Platform CSV Export

Downloadable from platform.openai.com/usage. Pre-aggregated by day + model.

**Expected columns** (case-insensitive):

| Column | Aliases |
|---|---|
| `date` | `timestamp`, `time` |
| `model` | `model_id` |
| `prompt_tokens` | `input_tokens` |
| `completion_tokens` | `output_tokens` |
| `cost_usd` | `cost`, `total_cost` |

**Example:**

```csv
date,model,num_requests,prompt_tokens,completion_tokens,total_tokens,cost_usd
2025-11-01,gpt-4o,45,52000,12000,64000,1.23
2025-11-02,gpt-4o-mini,120,80000,20000,100000,0.45
```

### Format C: JSON Array

A JSON file containing an array of objects with the same fields as Format A.

---

## Cursor IDE

Cursor stores conversation transcripts at `~/.cursor/projects/<encoded>/agent-transcripts/`.

**Status: Not supported.** Cursor transcript JSONL files only contain `{role, message: {content}}` — no token counts, model identifiers, or usage metadata. A parser cannot be created until Cursor adds usage data to its transcripts.

---

## Additional fields

### `project`

For Anthropic records, CostBuster extracts a project name from the `cwd` field (working directory) on each JSONL line. This enables the "Usage by Project" dashboard view.

If `cwd` is absent, the project is derived from the parent directory name under `projects/`.

OpenAI records have `project: null` since there is no equivalent concept in the supported formats.

---

## Adding a new data source

1. Point CostBuster to your file or directory using CLI flags or env vars.
2. Ensure your file matches one of the formats above.
3. Restart CostBuster (or click Refresh in the dashboard).
4. Check the Warnings section for any parse errors.
