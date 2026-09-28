# Testing Pyramid

How `/testgen` picks a test level when the `/spec` verification section names none for an AC (no **Verification Method**, or a method that does not say which level). When the spec does name a level, use it — this file never overrides the spec.

Adapted from Anthropic's `engineering:testing-strategy` rubric (#1135). Plain markdown, no plugin dependency.

## The pyramid

```
        /  E2E  \          Few, slow, high confidence
       / Integration \     Some, medium speed
      /   Unit Tests   \   Many, fast, focused
```

- **Unit** — one function or module, dependencies stubbed. Default for pure logic, parsers, formatters, validators, and state transitions. Maps to the **Unit Test** stub.
- **Integration** — two or more real modules together, or a module against a real boundary (filesystem, subprocess, HTTP layer, database). Default when the AC names a hand-off between components. Maps to the **Integration Test** stub.
- **E2E** — the whole system driven from its entry point (CLI binary, browser, public API). Reserve for the one or two ACs that describe a user-visible journey. Maps to **Browser Test** for UI, or an **Integration Test** stub that spawns the built entry point for a CLI.

Prefer the lowest level that can fail for the reason the AC cares about. Push a check up a level only when the lower level would have to mock the very thing under test.

## Level by component type

| Component | Unit | Integration | E2E / other |
|-----------|------|-------------|-------------|
| **API endpoint** | Business logic | HTTP layer: routing, status codes, validation | Contract tests for consumers |
| **CLI command** | Option parsing, output formatting | Command against a temp dir or fixture repo | Spawn the built binary once for the happy path |
| **Data pipeline** | Transformation correctness | Input validation, idempotency on re-run | — |
| **Frontend** | Component rendering | Interaction tests | Visual regression, accessibility (Browser Test) |
| **Infrastructure / scripts** | — | Smoke test against a sandbox | Load or chaos tests only when an AC names them |

## What to cover, what to skip

Cover: business-critical paths, error handling, edge cases, security boundaries, data integrity.

Skip: trivial getters/setters, framework code, one-off scripts — mark these **N/A - Trivial**.

## Recording the choice

When this file picked the level, say so in the stub header (`// Level chosen by testing-pyramid.md: spec named no verification method`) and in the Step 6 summary, so `/qa` can tell an inferred level from a specified one.
