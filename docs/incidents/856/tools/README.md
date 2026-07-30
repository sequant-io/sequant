# #856 measurement tools

Kept so the AC-3 result is reproducible rather than a claim, and so the next
occurrence of the hang can be measured the same way.

Both are standalone Node scripts — no build, no sequant import. Paths to
`entire.log` and the Claude desktop config are machine-specific constants at the
top of each file; adjust before reuse.

## `teardown-gap.mjs`

Per-session **last `TurnEnd` → `SessionEnd`** gap from `.entire/logs/entire.log`
— the "hung after finishing its turn" metric.

```sh
node teardown-gap.mjs ~/path/to/.entire/logs/entire.log            # all history
node teardown-gap.mjs ~/path/to/.entire/logs/entire.log 2026-07-29 # since a date
```

Prints the distribution plus the slowest teardowns with session ids and
timestamps. Validated against the incident: it reproduces the published 92.7s
and 58.0s victim gaps at their exact death timestamps.

**Do not** switch this to `SessionStop` — that event is a session phase
transition (`idle`/`active` → `ended`), pairs with `SessionEnd` for only 10 of
555 sessions, and yields multi-day gaps. The Claude Code Stop hook is `TurnEnd`.

## `ac3-mcp-experiment.mjs`

Runs N reps of a trivial Agent SDK query with and without `mcpServers`, then
reports each session's teardown gap. This is the AC-3 comparison.

```sh
REPS=3 node ac3-mcp-experiment.mjs
```

It reads MCP servers from the same path sequant's `getMcpServersConfig()` uses
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) —
**not** `~/.claude.json`. Two earlier runs of this experiment silently found
zero servers, which turned the treatment arm into a second control and produced
a convincing-looking null result. The script now throws rather than falling back
to "no MCP configured"; keep it that way.
