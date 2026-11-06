# Changelog fragments

Each PR that changes user-facing behavior adds one file here instead of editing
`CHANGELOG.md`, so two PRs never conflict on the changelog (#1351).

- Name: `<issue>-<slug>.md` (lowercase, e.g. `1351-changelog-fragments.md`).
- First line: `kind: Added|Changed|Fixed|Removed|Security`.
- Rest: the entry text, without a leading `- `. Start with a verb, end with `(#N)` context as in existing entries.

`/release` runs `npm run changelog:collate -- <version>`, which writes a
`## [<version>] - <date>` section grouped by kind, then deletes the fragments.
`npm run changelog:collate -- <version> --check` validates without writing.
Not user-facing (docs, tests, CI, internal refactor): add no fragment.
