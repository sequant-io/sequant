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
Set Height 360
Set Theme "Catppuccin Mocha"
Set Padding 24

# Boot the harness off-camera (and clear the prompt) so the GIF opens straight
# on the live TUI with no command line in frame.
Hide
Type "clear; npx tsx scripts/demo/run-grid-demo.ts"
Enter
Sleep 1.2s
Show

# Capture the full ~10s run: spec -> exec -> qa, live spinner + elapsed timer,
# green success rollup, and the durable "✔ #64" teardown line.
Sleep 10s
