# #856 measurement tools

## Start here: `verify-capture.sh`

**Run this before any capture attempt, and re-run it after touching the rig.**

The event is rare, destructive, and kills its own process tree — you get one
shot at recording it. If the rig is broken, an empty capture file is
indistinguishable from "nothing killed anything", and that reads as
_exoneration_ when it is really instrument failure. Every claim made from a
negative result depends on having first proved the instrument fires on a
positive one.

```sh
./verify-capture.sh        # poller + isolation layers (no sudo)
sudo ./verify-capture.sh   # adds the dtrace layer — required before trusting silence
```

It stages a sacrificial process group shaped like the real victim, group-kills
it with the same TERM→KILL escalation the incident showed, and asserts:

1. the poller records the deaths;
2. dtrace captures **both** signal 15 and signal 9 — a 15-only rig would miss
   the primary kill entirely, which is the flaw in AC-1's original predicate;
3. dtrace's fields are populated rather than blanked by SIP — a probe that
   fires with an empty sender tells you nothing about who killed whom;
4. **the rig outlives the group kill.** A watcher sharing the victim's process
   group dies with it and loses precisely the tail you needed. This is the
   failure most likely to go unnoticed: everything looks fine until the one
   time it matters.

Without sudo it reports **PARTIALLY verified** and says so explicitly — the
poller half is proven, the sender-identification half is not. Do not read a
negative dtrace result as evidence until the sudo run passes.

## The rest

Kept so the AC-3 result is reproducible rather than a claim, and so the next
occurrence of the hang can be measured the same way.

All of these are standalone — no build, no sequant import. The `.mjs` files run
under plain `node`, the `.sh` files under bash 3.2 (macOS ships no `setsid` and
no `timeout`, so neither is used). Paths to `entire.log` and the Claude desktop
config are machine-specific constants near the top of each file; adjust before
reuse.

| Script                   | Purpose                                                 | sudo                                     |
| ------------------------ | ------------------------------------------------------- | ---------------------------------------- |
| `verify-capture.sh`      | **Run first.** Positive-control test of the capture rig | optional (required for the dtrace layer) |
| `watch-signals.sh`       | Record signal deliveries + process-tree deaths          | optional                                 |
| `induce-bgpty-hang.sh`   | Deterministically wedge a bg-pty host (tier 2)          | no                                       |
| `teardown-gap.mjs`       | Per-session `TurnEnd → SessionEnd` gap                  | no                                       |
| `ac3-mcp-experiment.mjs` | The AC-3 MCP on/off comparison                          | no                                       |

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
