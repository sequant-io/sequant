# VS Code Extension for Workflow Visualization

The Sequant Explorer VS Code extension provides premium workflow visualization directly in your IDE sidebar.

## Overview

Instead of switching to a browser-based dashboard, the VS Code extension shows issue status and workflow phases where you already work. It reads the same `.sequant/state.json` file used by the CLI.

## Features

### Status-Grouped Tree View

The extension adds a Sequant panel to the Activity Bar with a premium tree structure:

```
📊 Overview: 3 issues · 1 in progress · 1 ready to merge
────────────────────────────────────────────────────
⚡ IN PROGRESS (1)
│
├── #218: Add user authentication [exec]     42m
│   ├── 📋 Acceptance Criteria (2/4 met)
│   │   ├── ✓ AC-1: Login form validates input
│   │   ├── ✓ AC-2: JWT tokens issued
│   │   ├── ○ AC-3: Refresh token rotation
│   │   └── ○ AC-4: Logout clears session
│   ├── 📍 Progress
│   │   ├── ✓ Spec                           3m
│   │   ├── ● Execute (in progress)         39m
│   │   └── ○ QA
│   ├── 🔗 Links
│   │   ├── → Open Worktree
│   │   ├── → View on GitHub
│   │   └── → Branch: feature/218-auth
│   ├── ⚠️ Long-running phase (1h 15m)
│   └── 💡 Action: Run /qa

✅ READY TO MERGE (1)
│
└── #215: Fix cart calculation              PR #342

📦 RECENTLY MERGED (last 7 days)
│
└── #120: VS Code extension                  2h ago
```

### Status Grouping

Issues are automatically grouped by status for quick visibility:

| Group | Includes | Icon |
|-------|----------|------|
| ⚡ IN PROGRESS | `in_progress`, `waiting_for_qa_gate`, `not_started` | Blue spinning |
| ✅ READY TO MERGE | `ready_for_merge` | Green check |
| 🔴 BLOCKED | `blocked` | Red warning |
| 📦 RECENTLY MERGED | `merged` (last 7 days) | Green merge |

### Acceptance Criteria Display

Each issue shows its acceptance criteria with status icons:

| Icon | Status |
|------|--------|
| ✓ | Met |
| ✗ | Not met |
| ○ | Pending |
| ⊘ | Blocked |

The parent node shows summary: "2/4 met"

### Time Tracking

- **Phase duration** displayed next to each phase (e.g., "3m", "1h 23m")
- **Total issue time** shown in issue description
- **Long-running warning** appears when a phase exceeds 1 hour

### Inline Errors

Failed phases display the error message inline:
```
✗ QA — "Type error in handler.ts:42"
```

Full error available in tooltip on hover.

### PR Integration

When a PR exists:
- PR number shown in issue description: `PR #342`
- Quick link to view PR
- Status icons for checks (future enhancement)

### Smart Actions

Context-aware suggestions appear based on issue state:

| State | Suggested Action |
|-------|------------------|
| Spec not started | "Run /spec" |
| Spec complete, no exec | "Run /exec" |
| Exec complete, no QA | "Run /qa" |
| Ready to merge | "Merge PR" |
| Blocked with failure | "Fix [phase] issues" |

### Right-Click Context Menu

Right-click any issue for actions:

| Action | Description |
|--------|-------------|
| Open Worktree in New Window | Opens VS Code with worktree as root |
| Open Worktree in Terminal | Opens terminal at worktree directory |
| View on GitHub | Opens issue in browser |
| View Pull Request | Opens PR in browser (if exists) |
| Copy Branch Name | Copies branch to clipboard |

### Auto-Refresh

The extension watches `.sequant/state.json` for changes and automatically updates the tree view when:
- A phase starts or completes
- Issue status changes
- New issues are added
- Acceptance criteria status changes

## Installation

### From VSIX (Recommended)

1. Build the extension:
   ```bash
   cd vscode-extension
   npm install
   npm run compile
   npx vsce package
   ```

2. Install in VS Code:
   - Open Command Palette (Cmd+Shift+P)
   - Run "Extensions: Install from VSIX..."
   - Select the generated `.vsix` file

### For Development

1. Open `vscode-extension/` folder in VS Code
2. Press F5 to launch Extension Development Host
3. Open a workspace containing `.sequant/state.json`

## Activation

The extension activates automatically when:
- A workspace contains `.sequant/state.json`

No manual activation required.

## Technical Details

### Lines of Code

| Component | LOC |
|-----------|-----|
| extension.ts | ~1100 LOC TypeScript |
| package.json | ~130 lines |

### Dependencies

- 0 runtime dependencies
- 3 dev dependencies: @types/node, @types/vscode, typescript

### Data Source

All data comes from `.sequant/state.json`:

| Feature | State Field |
|---------|-------------|
| Issue grouping | `issue.status` |
| AC display | `issue.acceptanceCriteria.items` |
| Time tracking | `phase.startedAt/completedAt` |
| Inline errors | `phase.error` |
| PR info | `issue.pr` |

## Configuration

Currently no configuration options. Future enhancements could include:
- Custom refresh interval
- Filter by status
- Keyboard shortcuts for actions
- Hide empty status groups

## Troubleshooting

### Extension not activating

1. Verify `.sequant/state.json` exists in workspace root
2. Check VS Code's Extension Host logs (Help > Toggle Developer Tools)
3. Try manual refresh via Command Palette: "Sequant: Refresh"

### Tree view empty

1. Check that state.json contains issues
2. Verify JSON is valid: `cat .sequant/state.json | jq`
3. Check for errors in Developer Tools console

### Status groups not appearing

Status groups only appear when they have issues. If all issues are in one status, only that group shows.

## Related

- [Workflow Phases](../concepts/workflow-phases.md)
- [State Command](../reference/state-command.md)
- Issue #114 - Web Dashboard (Option A)
- Issue #120 - VS Code Extension spike
- Issue #166 - Premium workflow visualization (this enhancement)
