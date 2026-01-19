# Dashboard Visualization Spike

This document summarizes the exploratory work done for issue #114 to evaluate approaches for visualizing Sequant workflow state.

## Background

The goal is to provide a "war room" view of project progress across issues and phases:
- See big picture across multiple issues
- Visual representation of phases (spec → exec → test → qa)
- Visibility into what's done, blocked, or in progress

## Options Explored

### Option A: Local Server Dashboard

**Implementation:** `sequant dashboard` command starts a local web server.

**Tech Stack:**
| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js | Already used by sequant |
| Server | Hono | Lightweight (~14kb), fast startup |
| Frontend | htmx + SSE | Server-rendered, minimal JS, efficient updates |
| Styling | Pico CSS | Classless framework, zero-effort styling |
| File watching | chokidar | Reliable cross-platform file watching |

**Files Created:**
- `dashboard/server.ts` - Hono server with SSE for live updates
- `src/commands/dashboard.ts` - CLI command wrapper

**Features:**
- Real-time updates via Server-Sent Events (SSE)
- Responsive grid layout for issues
- Phase progress visualization per issue
- Summary cards (total, in-progress, ready, blocked)
- Auto-opens browser on start
- Dark mode support (follows system preference)

**Effort Required:** ~4 hours for MVP
- Server setup with routes: 1.5 hours
- HTML/CSS layout with htmx: 1.5 hours
- SSE + file watching integration: 1 hour

**Limitations:**
- Requires running a separate terminal command
- Port conflicts possible (uses 3456 by default)
- No persistent state between dashboard restarts
- Limited interactivity (read-only view)

**UX Observations:**
- Quick startup (~200ms to first paint)
- Live updates work smoothly with SSE
- Phase visualization is clear and intuitive
- Works well with Pico CSS default styling

### Option C: VS Code Extension

**Implementation:** Tree view in VS Code activity bar showing issues and phases.

**Tech Stack:**
| Layer | Choice | Rationale |
|-------|--------|-----------|
| Framework | VS Code Extension API | Native integration |
| Language | TypeScript | Type safety, same as main project |
| File watching | VS Code FileSystemWatcher | Built-in, efficient |

**Files Created:**
- `vscode-extension/package.json` - Extension manifest
- `vscode-extension/src/extension.ts` - Tree view provider
- `vscode-extension/tsconfig.json` - TypeScript config

**Features:**
- Tree view with issues as parent nodes, phases as children
- Status icons with color coding
- Context menu actions (open worktree, open GitHub)
- Auto-refresh on state.json changes
- Tooltips with detailed phase information

**Effort Required:** ~3 hours for MVP
- Extension scaffolding: 30 minutes
- TreeDataProvider implementation: 1.5 hours
- Commands and context menus: 1 hour

**Limitations:**
- Only useful for VS Code users
- Constrained by tree view format (hierarchical only)
- No dashboard-style summary view
- Requires extension installation
- Publishing to marketplace requires setup

**UX Observations:**
- Integrates well with existing workflow
- Always visible in sidebar
- Quick access to worktree switching
- Tree view format may be too detailed for "war room" overview

## Comparison

| Aspect | Web Dashboard (A) | VS Code Extension (C) |
|--------|-------------------|----------------------|
| **Accessibility** | Any browser | VS Code only |
| **Setup** | Run command | Install extension |
| **Overview Quality** | Excellent (cards, grid) | Limited (tree only) |
| **Integration** | Separate window | Same IDE |
| **Real-time Updates** | SSE (smooth) | FileWatcher (native) |
| **Interactivity** | View only | Actions (open worktree) |
| **Maintenance** | Low (simple HTML) | Medium (VS Code API changes) |
| **Distribution** | Built into CLI | Separate package |

## Recommendation

**Pursue Option A (Web Dashboard) as the primary visualization solution.**

### Rationale:

1. **Lower barrier to entry**: No extension installation required
2. **Better overview experience**: Grid layout shows more context at once
3. **Tool agnostic**: Works regardless of IDE choice
4. **Simpler maintenance**: No VS Code API version tracking
5. **Already functional**: The spike produces a working dashboard

### Next Steps:

1. Merge dashboard command into main branch
2. Add dashboard tests (server routes, SSE)
3. Consider adding actions (e.g., open in IDE, view logs)
4. Document the `sequant dashboard` command

### Optional Future Work:

- **VS Code extension**: Could still be valuable as a complementary tool for quick status checks. Consider as a follow-up if users request it.
- **GitHub Actions integration**: Display workflow status in PR comments
- **Slack/Discord notifications**: Post status updates to team channels

## Validation

Both spikes successfully demonstrate:
- [x] Reading state.json and displaying worktree/phase data
- [x] Live updates when state changes
- [x] Phase status visualization (pending, in_progress, completed, failed, skipped)
- [x] Issue status display (in_progress, ready_for_merge, blocked, etc.)

## Dependencies

- #115 (state tracking) - **CLOSED** - Required for dashboard to have data to display
- #116 (CLI command) - Will build on this spike's results
