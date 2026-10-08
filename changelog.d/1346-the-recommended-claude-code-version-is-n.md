kind: Fixed

**The recommended Claude Code version is now 2.1.288 (#1346).** Sequant relies on Claude Code's native dangerous-`rm` analyzer, which before 2.1.288 let a `bash -c` or `sh -c` script run a dangerous `rm` without a prompt under `bypassPermissions`, the mode phase agents run in. The README gives the new recommendation and the reason, and `docs/THREAT-MODEL.md` lists the analyzer as a defense with that version dependency. ADR-0009 (#1345) is accepted.
