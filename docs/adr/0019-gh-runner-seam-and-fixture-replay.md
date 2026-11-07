# ADR-0019: Every `gh` call goes through one runner seam; tests replay captured output through it

**Status:** Proposed
**Date:** 2026-10-20
**Issue:** #1506

## Context

The fix-seam audit (59 merged fixes, 28 days) found that subprocess was the one seam tested through mocks. Three of four subprocess defects were tested by mocking `child_process`, and two logic fixes (#1229, #1214) used hand-typed copies of `gh`'s output. When the copy drifts from what `gh` prints, the test stays green and the code is wrong. Six test files faked `gh` inside a `child_process` mock, and more did it without writing the literal `"gh"` (a mock queue of `spawnSync` answers in call order, with `gh` and `git` interleaved). Four call sites spawned `gh` outside `GitHubProvider`: two in `batch-executor.ts`, one in `chain-preflight.ts`, one in `merge-check/report.ts`. The `gh` exit-status seam had been fixed four times (#1319, #1320, #1464, #1268).

## Decision

`GitHubProvider` takes an optional `GhRunner` in its constructor, and every `gh` call in the class goes through it. The default runner is the only `spawnSync("gh", …)` in `src/`. A non-zero exit, a timeout or a failed spawn throws `GhCommandError` (with `args`, `exitCode`, `signal`, `stderr`). `FakeGitHubProvider` is `GitHubProvider` with a runner that answers from JSON fixtures in `src/lib/workflow/platforms/__fixtures__/gh/`. `scripts/capture-gh-fixtures.ts` produces those fixtures by running the real `gh` (read-only calls only). The four outside call sites take an optional `provider` that defaults to `new GitHubProvider()`.

## Options

### Option A: A runner seam inside the real provider, and a fake that subclasses it (chosen)

The fake changes only what produces `gh`'s output. **Pros:** every interface method and every sync helper (`fetchIssueCommentBodiesSync`, `listClosedIssuesSync`, `createPRCliSync`, …) runs the production parsing and throws the production error class, so "a fixture with `exitCode: 1` throws what `GitHubProvider` throws" is true by construction. A test that needs a variant derives it from a captured fixture (`deriveGhFixture`), so the shape stays the one `gh` prints. **Cons:** the fake is coupled to the provider's argv; a change to a call's flags needs a fixture recapture.

### Option B: A standalone `FakeGitHubProvider implements PlatformProvider`

The issue's literal wording. **Pros:** no change to `GitHubProvider`'s constructor. **Cons:** it covers only the 9 interface methods, not the sync helpers the converted tests exercise. It would re-implement parsing, which brings back the hand-typed output shapes this change exists to remove, and its errors would only resemble the provider's.

### Option C: A module-level test setter on `github.ts`

**Pros:** no constructor parameter. **Cons:** global state that a test can leak into the next (D-D rules it out), and it would not let one test give two providers different answers.

## Trade-offs

Option A wins because the defect class is drift between what the code parses and what `gh` prints, and only Option A keeps the production parser in every test. It gives up independence from argv: a fixture matches the exact argv the provider sends (an `<*>` token matches any value), so a flag change shows up as `GhFixtureMissingError`, which names the capture script. That failure is loud and points at the fix.

Code under test that builds its own `GitHubProvider` (doctor, state cleanup, PR creation, resume) is not rewired, because those files are out of the issue's scope. Their tests `vi.mock` the provider module and export a replaying subclass (`replayGitHubModule`). That mocks a module this repo owns, and the output still comes from captured fixtures.

## Consequences

- Easier: a `gh` failure in a test is a fixture (`pr-comment-http-502`, `pr-comment-timeout`, `pr-comment-gh-missing`), not a shifted mock queue.
- Easier: a unit test that forgets to stub `gh` gets `GhFixtureMissingError` from a fake instead of spawning the real binary (the #1560 class) — when it uses the fake or the replay mock.
- Harder: tolerant sync helpers (`return null` / `[]` on failure) also swallow `GhFixtureMissingError`, so a missing fixture behind one of them reads as "gh failed". Assert on `calls` when that distinction matters.
- Harder: fixtures are public; the capture script captures only public `sequant-io/sequant` data, scrubs `gh auth status`, and refuses any writing argv. Write paths have hand-written fixtures marked `"provenance": "hand-written"`.
- Revisit when #1505 converts the empty catches in `github.ts`, and if a second platform provider needs the same seam.
