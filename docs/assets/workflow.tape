# Sequant Workflow Demo
# Run: vhs workflow.tape

Output workflow.gif

Set FontSize 15
Set Width 750
Set Height 500
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Padding 20

# Header
Type "# Issue #123: Add user authentication"
Enter
Enter
Sleep 800ms

# Spec phase
Type "/spec 123"
Enter
Sleep 400ms
Type "Reading issue #123..."
Enter
Type "Analyzing codebase..."
Enter
Sleep 400ms
Type "✓ 5 acceptance criteria identified"
Enter
Type "✓ Implementation plan posted to issue"
Enter
Sleep 800ms
Enter

# Exec phase
Type "/exec 123"
Enter
Sleep 400ms
Type "Creating worktree: feature/123-user-auth"
Enter
Type "Implementing changes..."
Enter
Sleep 400ms
Type "✓ 4 files modified"
Enter
Type "✓ npm test: 47 passed"
Enter
Type "✓ PR #124 created"
Enter
Sleep 800ms
Enter

# QA phase
Type "/qa 123"
Enter
Sleep 400ms
Type "Running quality checks..."
Enter
Sleep 400ms
Type "✓ Type safety: 0 issues"
Enter
Type "✓ Security scan: PASS"
Enter
Type "✓ AC coverage: 5/5 MET"
Enter
Enter
Type "Verdict: READY_FOR_MERGE"
Enter
Sleep 2s
