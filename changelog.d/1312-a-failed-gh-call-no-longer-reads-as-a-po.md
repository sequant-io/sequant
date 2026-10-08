kind: Fixed

**A failed `gh` call no longer reads as a posted comment or label (#1312).** `GitHubProvider.postComment`, `addLabel` and `removeLabel` ran `spawnSync` and never looked at the result, so a non-zero exit, a timeout or a failed spawn resolved as success and `postQaVerdictComment`'s "Failed to post QA verdict comment" warning could never fire. They now throw with `gh`'s stderr, so a lost QA verdict is logged.
