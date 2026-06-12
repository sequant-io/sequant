# Sequant Run Grid — boxed Ink TUI demo (#695)
#
# Records the REAL branded boxed TUI (src/ui/tui/) driven by a privacy-safe,
# fictional snapshot (#64: Add user authentication). Nothing real is touched —
# see scripts/demo/run-grid-demo.ts.
#
# Run from the REPO ROOT (the harness needs tsx + node_modules + tsconfig):
#   vhs docs/assets/run-grid.tape

Output docs/assets/run-grid.gif

Set FontSize 16
Set Width 920
Set Height 430
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 55ms

# Off-camera: alias `sequant` to the demo harness so the on-screen command reads
# `sequant run 64` (the real command this UI belongs to) while the genuine boxed
# TUI renders. The trailing `#` comments out the cosmetic `run 64` args, which
# the harness ignores anyway. Then clear so the GIF opens on a clean prompt.
Hide
Type `alias sequant='npx tsx scripts/demo/run-grid-demo.ts #'`
Enter
Type "clear"
Enter
Show

# Type the command on-camera for context, then run it.
Type "sequant run 64"
Sleep 700ms
Enter

# Boot lag, then the full run: spec -> exec -> qa, live spinner + elapsed timer,
# green success rollup, and a hold on the durable "✔ #64" teardown summary line.
Sleep 1.2s
Sleep 12s
