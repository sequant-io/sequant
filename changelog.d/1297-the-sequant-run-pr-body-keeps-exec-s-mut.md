kind: Fixed

**The `sequant run` PR body keeps exec's mutation markers and AC table when exec wrote no `## Summary` (#1297).** The body now carries every valid `SEQUANT_MUTATION` marker from exec's final output, including markers exec fenced in a code block (outside the 4,000-character cap, never duplicated) and, with no Summary, the AC table; the placeholder only appears when there is nothing to carry, and the run output warns when it does. The issue state's stored summary carries the markers too, so a qa-only re-run's PR update keeps them.
