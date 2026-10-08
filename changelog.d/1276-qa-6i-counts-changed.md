kind: Fixed

`/qa` §6i counts changed `.github/workflows/*.yml` and `*.yaml` files in its diff-file list, so a `SEQUANT_MUTATION` marker naming a CI workflow step classifies `valid` instead of `test_not_in_diff` (#1276)
