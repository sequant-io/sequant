# Sequant Workflow Demo - Step by Step
# Run: vhs workflow.tape
# Output: workflow.gif

Output workflow.gif

# Terminal settings
Set FontSize 16
Set Width 900
Set Height 600
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Padding 20

# Title
Type "# Sequant Workflow Demo"
Enter
Sleep 1s
Type "# Issue #123: Add user authentication"
Enter
Sleep 1s
Enter

# Step 1: Spec
Type "# Step 1: Plan the implementation"
Enter
Sleep 500ms
Type "/spec 123"
Enter
Sleep 2s
Type "# ✓ Acceptance criteria drafted"
Enter
Type "# ✓ Implementation plan created"
Enter
Sleep 1s

# Step 2: Exec
Enter
Type "# Step 2: Implement in isolated worktree"
Enter
Sleep 500ms
Type "/exec 123"
Enter
Sleep 2s
Type "# ✓ Feature branch created"
Enter
Type "# ✓ Code implemented"
Enter
Type "# ✓ Tests passing"
Enter
Sleep 1s

# Step 3: QA
Enter
Type "# Step 3: Quality review"
Enter
Sleep 500ms
Type "/qa 123"
Enter
Sleep 2s
Type "# ✓ Type safety: PASS"
Enter
Type "# ✓ Security scan: PASS"
Enter
Type "# ✓ AC coverage: 5/5 MET"
Enter
Type "# → Verdict: READY_FOR_MERGE"
Enter
Sleep 2s

# End
Enter
Type "# PR ready for human review!"
Sleep 3s
