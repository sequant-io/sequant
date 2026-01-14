# Sequant Demo - Quick Start
# Run: vhs demo.tape
# Output: demo.gif

Output demo.gif

# Terminal settings
Set FontSize 18
Set Width 800
Set Height 500
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Padding 20

# Show the init command
Type "npx sequant init"
Sleep 500ms
Enter
Sleep 3s

# Show doctor check
Type "npx sequant doctor"
Sleep 500ms
Enter
Sleep 2s

# Clear and show Claude Code usage
Type "clear"
Enter
Sleep 500ms

# Simulate Claude Code prompt (this would need adjustment for actual Claude Code)
Type "# In Claude Code, type:"
Enter
Sleep 500ms
Type "/fullsolve 123"
Sleep 2s
Enter

# End
Sleep 3s
