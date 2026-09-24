# Writing an agent driver

Sequant runs its phases through an **agent driver** — the seam between workflow
orchestration and whichever coding agent actually does the work. Claude Code is
the default; `codex`, `opencode` and `aider` ship alongside it.

This page is for anyone adding a fifth. It states the contract a driver has to
satisfy, and points at the test suite that enforces it.

## The interface

Implement [`AgentDriver`](../../src/lib/workflow/drivers/agent-driver.ts) and
register it in
[`src/lib/workflow/drivers/index.ts`](../../src/lib/workflow/drivers/index.ts):

```ts
const DRIVERS: Record<string, (opts?: DriverOptions) => AgentDriver> = {
  "claude-code": () => new ClaudeCodeDriver(),
  aider: (opts) => new AiderDriver(opts?.aiderSettings),
  opencode: (opts) => new OpencodeDriver(opts?.opencodeSettings),
  codex: (opts) => new CodexDriver(opts?.codexSettings),
  // your driver here
};
```

`DRIVERS` is the single enumeration source. `listDriverNames()` exports its
keys, and the conformance suite builds its cases from that — so registering a
driver is also what opts it into the contract below. There is no way to add one
quietly.

## The conformance contract

Six items, all enforced by
[`src/lib/workflow/drivers/__tests__/driver-conformance.test.ts`](../../src/lib/workflow/drivers/__tests__/driver-conformance.test.ts).

### 1. Commit

Inside the driver's **default** sandbox, in a git worktree, `git add` and
`git commit` must succeed.

The Codex driver's first real run produced correct edits across four files and
then failed with "made no commits": `workspace-write` makes the workspace
writable but excludes `.git/`, so every `git add` was denied with
`fatal: Unable to create '…/.git/index.lock': Operation not permitted`
([#1076](https://github.com/sequant-io/sequant/issues/1076)). A phase that
cannot commit cannot finish, whatever else it gets right.

### 2. Network

`gh api rate_limit` must succeed from inside that same sandbox whenever the run
needs the platform.

`workspace-write` also disables network access. The phase could not
`gh issue view` the issue it was working on, post a spec comment, or push
([#1079](https://github.com/sequant-io/sequant/issues/1079)). The exec agent
reconstructed its task by grepping the repo for the issue number, never having
read the issue.

### 3. Typed error mapping

- A quota-exhausted failure maps to `BillingError`, with the reset time in
  `metadata`.
- A transient throttle maps to `RateLimitError`, and is retryable.
- Anything else maps to a `SequantError` carrying the driver's own error code.

`--auto-wait` ([#804](https://github.com/sequant-io/sequant/issues/804)) and the
billing-aware fallback skip
([#592](https://github.com/sequant-io/sequant/issues/592)) both key off those
classes. A driver that types quota exhaustion as `unknown` makes the quality
loop re-run straight back into the same exhausted quota — measured at 4.7s
([#1087](https://github.com/sequant-io/sequant/issues/1087)).

Fixture texts live in
[`__fixtures__/`](../../src/lib/workflow/drivers/__fixtures__/), with their
provenance recorded in
[`__fixtures__/PROVENANCE.md`](../../src/lib/workflow/drivers/__fixtures__/PROVENANCE.md).
Capture your driver's real failure messages — a reconstructed message is worth
less than no fixture, because it looks like evidence.

### 4. Env injection

The phase must see `SEQUANT_ORCHESTRATOR`, `SEQUANT_WORKTREE`, `SEQUANT_PHASE`
and `SEQUANT_ISSUE` — the same four for every driver. Skills and hooks read
them to tell an orchestrated phase from an interactive session.

A driver may add to the child env (opencode redirects `XDG_CONFIG_HOME` for
hermeticity); it may not drop `config.env`.

### 5. Structured outcome

`executePhase` returns `{ success, output, structuredError?, modelUsage }`. On a
completed turn, `modelUsage` must carry real counters, so a token total is
derivable (`inputTokens + outputTokens`, as
[`token-utils.ts`](../../src/lib/workflow/token-utils.ts) does it).

Note what is *not* on this interface: `verdict` is parsed downstream in
`phase-executor.ts`, and `tokensUsed` is derived rather than stored. Do not add
either field to `AgentPhaseResult` to satisfy the contract.

### 6. Skill load

If the driver executes phases by resolving sequant's skills
(`resolvesSkills === true`), it must actually load the **project-scope** tree —
not a user-scope or bundled copy
([#813](https://github.com/sequant-io/sequant/issues/813),
[#992](https://github.com/sequant-io/sequant/issues/992)). The evidence differs
per backend: Claude Code needs `settingSources: ["project"]`; codex resolves
`$<skill>` through `.agents/skills`; opencode's stream carries a `skill` tool
call.

## Adding your adapter

Each driver supplies one `ConformanceAdapter` in the suite, covering the six
items. **A registered driver with no adapter fails the suite**, as does an
adapter naming no registered driver — the pair of guards is deliberate, so
neither half can be satisfied alone.

Probe the real thing wherever the vendor allows it at no cost. The codex commit
and network probes run the actual `codex sandbox`, configured from the writable
roots the driver itself computed, so removing the `.git` root from the driver
breaks the probe. Only the Claude Agent SDK is mocked, at the module edge.

### When an item cannot run

Record a **typed skip reason**. The suite asserts the form, so a skip always
names a cause:

| Form | Means |
|------|-------|
| `structural: <why>` | The driver has no such concept — aider has no sandbox and resolves no skills. |
| `gap: #NNNN <what>` | The driver *should* support it and does not. Needs a real tracking issue. |
| `unavailable: <what>` | The environment cannot run the probe — no `codex` binary, no authenticated `gh`. |

A missing binary is `unavailable:`, never `structural:`. Conflating the two
turns "we could not check" into "this driver legitimately lacks the
capability", which is how a gap stays invisible.

## Running it

```bash
npx vitest run src/lib/workflow/drivers/__tests__/driver-conformance.test.ts

# One driver
npx vitest run src/lib/workflow/drivers/__tests__/driver-conformance.test.ts -t "codex"

# One item
npx vitest run src/lib/workflow/drivers/__tests__/driver-conformance.test.ts -t "codex commit"
```

The file sits in the `unit` vitest project, which keeps a 5s default timeout, so
every case that shells out passes an explicit per-test timeout.

## See also

- [Codex agent backend](../features/codex-agent-backend.md)
- [`AgentDriver` interface](../../src/lib/workflow/drivers/agent-driver.ts)
- [Fixture provenance](../../src/lib/workflow/drivers/__fixtures__/PROVENANCE.md)
