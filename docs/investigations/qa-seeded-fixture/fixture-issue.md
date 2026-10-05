# Add `notes export` and `notes serve`

`notes` can list notes but can't get them out. Add an export command and a local
Markdown preview.

## Acceptance Criteria

- [ ] AC-1: `notes export --format json|md` prints every note in the store to stdout, as JSON (default) or Markdown.
- [ ] AC-2: `notes export --since <date>` prints only the notes created on or after `<date>`. An unparseable date is an error.
- [ ] AC-3: When the store file is missing or isn't valid JSON, `notes export` prints an error to stderr and exits 1.
- [ ] AC-4: `notes serve --port <n>` serves a live Markdown preview of the store, reachable from this machine only (localhost).
- [ ] AC-5: An integration test runs the built CLI (`node dist/cli.js export`) against a temporary store and checks its stdout.
