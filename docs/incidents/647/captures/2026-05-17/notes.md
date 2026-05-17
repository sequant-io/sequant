# Capture notes — 2026-05-17

## Run command

```bash
SEQUANT_DEBUG_RENDERER=1 script -q terminal.typescript \
  npx sequant run 658 -q 2> debug.jsonl
```

- `-q` was the short form for `--quality-loop` at the time of this capture (#658 ships the rebind to `--quiet`).
- Run completed: `#658 → PR #660 (36m 8s, 1 passed)`.
- `node` version + terminal: see `terminal.typescript` opening lines (script's header).

## Artifacts

| File | Size | Notes |
|---|---|---|
| `scrollback.txt` | 2.4 KB | Manual save (Cmd+A, Cmd+C, `pbpaste`) from an earlier `#656` run. Smaller sample of the same Mechanism #1 pattern. |
| `terminal.typescript` | 3.1 MB | `script(1)` byte-stream capture of the `#658` run. **Authoritative artifact.** |
| `debug.jsonl` | (removed) | Was 0 bytes because `script` records both stdout and stderr into the typescript file, so the `2> debug.jsonl` redirect never received any stderr. |

## Key counts (`terminal.typescript`)

```
$ wc -l terminal.typescript           19702 lines
$ grep -c "SEQUANT WORKFLOW"          2181 occurrences
$ grep -c "SEQUANT_DEBUG_RENDERER"    2210 occurrences
```

## Symptom 1 — Mechanism #1 (duplicate-header scrollback)

Confirmed reproducing at scale: 2,181 `SEQUANT WORKFLOW · #N · Xs elapsed` lines persisted in scrollback over a 36-minute run (~1 per second). Every renderer redraw fails to erase the previous frame; each second-tick leaves a fresh header trapped in scrollback as the frame scrolls.

This is the AC-1 evidence #647 was waiting for.

## Symptom 2 — Mid-string character drops + U+FFFD overlay

Distinct from #655 Symptom A (which is a `complete[0:8] + failed[9:]` overlay). Here, individual characters or short runs vanish from arbitrary mid-string positions:

```
SEQUANT WORKFLOW · #658 ·  31s elapsed     # "28m" elided (cols 25-27)
SEQUANT WORKFLOW · 8 · 29m 19s elapsed     # "#65" elided
SEQUANT WORW · #658 · 35m 7s elapsed       # "KFLO" elided mid-WORKFLOW
SEQUANT WORKFLOW �#658 · 28m 55s elapsed   # U+FFFD where "·" should be
```

## Caveat — `script` wrapper interference

The `script(1)` wrapper records the entire pty (stdout AND stderr) into `terminal.typescript`. Because the AC-1 instrumentation correctly writes to stderr (`run-renderer.ts:605` → `process.stderr.write`), its output ended up in the typescript file mixed with renderer stdout writes.

This means:
- Visual interleaving of `SEQUANT_DEBUG_RENDERER {...}` lines into renderer table writes (visible at table-border breakpoints in the file) is a `script` artifact, not a renderer bug.
- To discriminate Symptom 2's cause (renderer alone vs. exacerbated by stderr co-writer), a follow-up capture without `script` is needed: `SEQUANT_DEBUG_RENDERER=1 npx sequant run <issue> -q 2> debug.jsonl` plus manual terminal save.
