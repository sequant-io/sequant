# Sequant Run Grid — boxed Ink TUI demo (#695)
#
# Records the REAL branded boxed TUI (src/ui/tui/) driven by a privacy-safe,
# fictional snapshot (#64: Add user authentication). Nothing real is touched —
# see scripts/demo/run-grid-demo.ts.
#
# Run from the REPO ROOT (the harness needs tsx + node_modules + tsconfig):
#   vhs docs/assets/run-grid.tape

Output docs/assets/run-grid.gif

# Rendered at ~1.75x (font + canvas) so it downscales crisply to retina when the
# README embeds it at width=760.
Set FontSize 28
Set Width 1610
Set Height 760
Set Theme "Catppuccin Mocha"
Set Padding 42
Set TypingSpeed 75ms

# Off-camera: alias `sequant` to the demo harness so the on-screen command reads
# `sequant run 64` (the real command this UI belongs to) while the genuine boxed
# TUI renders. The trailing `#` comments out the cosmetic `run 64` args, which
# the harness ignores anyway. Then clear so the GIF opens on a clean prompt.
Hide
Type `alias sequant='./node_modules/.bin/tsx scripts/demo/run-grid-demo.ts #'`
Enter
Type "clear"
Enter
Show

# Type the command on-camera for context, then run it.
Type "sequant run 64"
Sleep 700ms
Enter

# Hide the interpreter boot off-camera (VHS excludes hidden time from the GIF),
# so the recording cuts straight from the command to the calm queued TUI with no
# dead gap. The sleep must exceed boot; the local tsx binary boots well under
# this. RUN_BASE is set at module load, so the queued lead-in plays on reveal.
Hide
Sleep 2.5s
Show

# The full run: a calm queued lead-in, spec -> exec -> qa with a live spinner +
# elapsed timer, the green success rollup, and a hold on the durable "✔ #64"
# teardown summary line.
Sleep 12s
