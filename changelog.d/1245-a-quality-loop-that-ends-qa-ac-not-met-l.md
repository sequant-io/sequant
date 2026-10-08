kind: Fixed

A quality loop that ends `qa AC_NOT_MET → loop → qa NEEDS_VERIFICATION` records `awaiting_verification` instead of `ready_for_merge`, and the PR-body QA note and the MCP `sequant_run` result (`verdict`, `acMet`/`acTotal`, `gaps`, `findings`) report the latest qa pass, not the first (#1245). The latest-attempt accessor moved to `src/lib/workflow/latest-phase.ts`; the failed-phase scans in `deriveFailureCategory` and `run-display.ts` use it too
