# Add `notes import`

`notes` can list notes, but there's no way to bring notes in from another file. Add an import command.

## Acceptance Criteria

- [ ] AC-1: `notes import <file>` appends the notes in `<file>` to the store. An imported note whose `id` is already in the store gets a fresh id, so ids stay unique.
- [ ] AC-2: `notes import <file> --dedupe` skips imported notes whose title and body match a note already in the store.
- [ ] AC-3: `notes import <file> --dry-run` prints what would be imported and leaves the store unchanged. The README documents the command and both flags.
- [ ] AC-4: An import file that isn't a JSON list of notes is an error: a message on stderr, exit 1, and the store unchanged.
- [ ] AC-5: Tests cover import, `--dedupe` and `--dry-run`, each asserting on the resulting store.
