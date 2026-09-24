# Driver fixture provenance

Where each fixture in this directory came from, and — where a fixture is not a
verbatim capture — exactly which part was reconstructed. A fixture whose origin
is unstated is a fixture nobody can tell apart from a guess.

| Fixture | Origin |
|---------|--------|
| `codex-exec-skill-hook.jsonl` | Verbatim capture, #497 probe (`codex exec --json`, codex-cli 0.154.0). |
| `codex-turn-failed-usage-limit.jsonl` | **Verbatim.** The `error` and `turn.failed` envelopes are byte-identical to `stdoutTail[48]` and `stdoutTail[49]` of the #1060 gate **run 2** record (`.sequant/logs/run-2026-09-18T12-31-04-2ea6990e-cd77-4538-abca-035930b44f07.json`, 2026-09-18 12:31Z, ChatGPT free plan). The surrounding `thread.started` / `turn.started` lines are added so the file is a well-formed stream; `thread_id` reuses the run's own id. |
| `codex-turn-failed-rate-limit.jsonl` | **Partly reconstructed — read this before trusting it.** The `rate limit exceeded: ` prefix is codex's own format string, read out of the 0.154.0 binary (`strings`), as is the sibling `You've hit your usage limit.` family that the fixture above captures live. The detail after the colon is the OpenAI API's documented 429 body shape; **no transient-throttle `turn.failed` has been captured from a real run**, so the wording after the prefix is not evidence. Replace it with a real capture the first time one is observed — see #1087. |
| `codex-turn-failed-unrecognized.jsonl` | **Reconstructed** from two of codex's own format strings (`stream error: `, `stream disconnected before completion: `). Its only job is to be a message that matches *no* billing or throttle pattern, so the exact wording carries no weight — but it must stay a plausible codex message rather than a nonsense string, or the "falls through to the generic error" case stops resembling the thing it guards. |
| `opencode-run-qa.ndjson` | Verbatim capture of a real `opencode run --command qa` (#862 / #992 field evidence, opencode 1.18.27). Confidential per #862 — do not quote its contents outside this repo. |

## Consumers

- `driver-conformance.test.ts` (#1096) — contract items 3 (error mapping), 5
  (structured outcome) and 6 (skill load).
- `codex.test.ts` — #1087 lands the codex `BillingError` / `RateLimitError`
  mapping and reuses the three `codex-turn-failed-*.jsonl` files above.
