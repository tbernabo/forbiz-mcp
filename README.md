# forbiz-mcp

**MCP server for [Forbiz](https://forbiz.io), the CRM for AI agents.** Your business continues when your AI changes.

Give your agent a place to keep what it committed to, the signal it expects back, the evidence it saw and how things turned out — so the next session, or the next agent, picks up where the last one left off.

- **No account to start.** The agent opens a provisional workspace by itself with `forbiz_start`. The owner claims it later with a link.
- **Commitments that can be resumed.** Every commitment carries a `commitmentKey`. Opening the same one twice is refused, and the refusal returns the open commitment: that is how a fresh session continues.
- **Evidence is not truth.** What the agent writes is append-only history. A contradiction never erases what it contradicts, and nothing becomes workspace truth until a human confirms it.
- **Who did what is recorded.** Every write is attributed to the agent that made it, and `forbiz_agents` shows each agent's track record.

## Install

Requires Node 18 or later.

**Claude Code**

```bash
claude mcp add forbiz -- npx -y forbiz-mcp
```

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "forbiz": {
      "command": "npx",
      "args": ["-y", "forbiz-mcp"]
    }
  }
}
```

That is enough: the agent calls `forbiz_start` the first time and the credential is stored in `~/.forbiz-mcp/credential.json`.

**Already have a Forbiz credential?** Add it to the server's environment instead:

```json
"env": { "FORBIZ_API_KEY": "<your credential>" }
```

Credentials starting with `fbzr_` are exchanged automatically for a short-lived token.

## Tools

| Tool | What it does |
|---|---|
| `forbiz_start` | Open a provisional workspace, no account. Stores the credential locally; never shows it |
| `forbiz_me` | Workspace, identity, capabilities, plan and limits. Call it first |
| `forbiz_next` | The single next thing that needs attention |
| `forbiz_prompts` | Everything pending, grouped, with the commands available right now |
| `forbiz_state` | Workspace overview |
| `forbiz_commit` | Record a commitment with its expected signal and date |
| `forbiz_mark_executed` | Record that the action really happened |
| `forbiz_check_signal` | Record where and when you looked for the signal |
| `forbiz_record_signal` | Record what actually came back |
| `forbiz_postpone` | Move the expected signal date |
| `forbiz_close` / `forbiz_close_without_signal` | Close the loop |
| `forbiz_get_action` / `forbiz_action_history` | One action, and who changed it |
| `forbiz_add_evidence` / `forbiz_find_evidence` | Append and recover evidence |
| `forbiz_search` | Search across actions, evidence, people, projects |
| `forbiz_agents` | Agents of the workspace and their track record |
| `forbiz_claim_link` | The link the owner opens to take ownership |
| `forbiz_request` | Any other route of the [Agent API](https://forbiz.io/openapi.json) |

## A first cycle

1. `forbiz_start` → workspace and trial limits.
2. `forbiz_add_evidence` → what you observed (`kind: statement`, `epistemicStatus: observed`).
3. `forbiz_commit` → what you will do, with `commitmentKey`, `expectedSignal` and `expectedSignalAt`.
4. `forbiz_mark_executed` when it happened, then `forbiz_record_signal` or `forbiz_check_signal`.
5. `forbiz_claim_link` → hand the link to the owner.

## Plans

Trial: free, one agent, 30 actions and 100 evidence records; after that the workspace stays readable and exportable, nothing is deleted. Continuity: USD 29/month. `forbiz_me` returns the current catalog, which is authoritative.

## How it works

A thin translation of the public Forbiz Agent API into MCP tools. It adds no rules of its own: duplicates, capabilities and limits are enforced by Forbiz, and every refusal reaches the agent as Forbiz wrote it, because the refusal says what to do next. Tool results are scrubbed of credentials before they reach the model.

Configuration: `FORBIZ_API_KEY` (optional credential), `FORBIZ_API_BASE` (default `https://forbiz.io/api/public/agent`), `FORBIZ_MCP_HOME` (default `~/.forbiz-mcp`).

## Links

- Forbiz: https://forbiz.io
- Agent API: https://forbiz.io/openapi.json · https://forbiz.io/llms.txt
- Handoff test (can a cold agent resume a commitment?): https://github.com/tbernabo/handoff-test

MIT License.
