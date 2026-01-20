# Dashboard Visualization Spike

This document summarizes the exploration of two approaches for visualizing Sequant workflow state.

## Background

Sequant's workflow is session-focused, making it harder to see the big picture across multiple issues. A visual representation of phases (spec → exec → test → qa) could help catch gaps and provide better visibility into what's done, blocked, or in progress.

## Options Explored

### Option A: Local Server Dashboard

A web-based dashboard accessible via `sequant dashboard` command.

**Tech Stack:**
| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node | Already used by sequant |
| Server | Hono | Lightweight (~14kb), fast startup |
| Frontend | htmx | Server-rendered, minimal JS, handles refresh patterns |
| Styling | Pico CSS | Classless framework, looks decent with zero effort |
| Live updates | SSE | Simpler than WebSocket, efficient than polling |
| File watching | chokidar | Reliable cross-platform file watching |

**Features Implemented:**
- Grid layout showing all tracked issues
- Phase progress visualization with icons
- Status badges (in_progress, ready_for_merge, blocked, etc.)
- PR links and worktree paths
- SSE-based live updates when state.json changes
- Connection status indicator

**Usage:**
```bash
# Start dashboard on default port (3456)
npx sequant dashboard

# Custom port
npx sequant dashboard --port 8080

# Don't auto-open browser
npx sequant dashboard --no-open
```

**Directory Structure:**
```
sequant/
  dashboard/
    server.ts      # Hono server, SSE, HTML rendering
  src/commands/
    dashboard.ts   # CLI command wrapper
```

### Option C: VS Code Extension

A sidebar extension providing a tree view of issues and phases.

**Tech Stack:**
| Layer | Choice | Rationale |
|-------|--------|-----------|
| API | VS Code Extension API | Required for IDE integration |
| Tree View | TreeDataProvider | Standard VS Code pattern |
| File watching | FileSystemWatcher | Built-in VS Code API |

**Features Implemented:**
- Activity bar icon for Sequant
- Tree view with issues as parent nodes
- Phases as child nodes with status icons
- Context menu actions (open worktree, open on GitHub)
- Automatic refresh on state.json changes
- Rich tooltips with issue details

**Usage:**
1. Open VS Code in a workspace with `.sequant/state.json`
2. Extension activates automatically
3. Click "Sequant" icon in activity bar
4. Expand issues to see phase progress

**Directory Structure:**
```
vscode-extension/
  package.json     # Extension manifest
  tsconfig.json    # TypeScript config
  src/
    extension.ts   # Main extension code
```

## Comparison

| Aspect | Option A: Web Dashboard | Option C: VS Code Extension |
|--------|------------------------|----------------------------|
| **Setup** | Run CLI command | Install extension |
| **Accessibility** | Any browser | VS Code only |
| **Overview** | Grid layout, see all at once | Tree view, expand/collapse |
| **Updates** | SSE (real-time) | FileSystemWatcher (real-time) |
| **Actions** | Links, basic navigation | Terminal, GitHub integration |
| **Maintenance** | Low (web standards) | Medium (VS Code API changes) |
| **Dependencies** | Hono, chokidar, open | VS Code types only |

### Effort Comparison

| Task | Option A | Option C |
|------|----------|----------|
| Initial setup | 2h | 3h |
| Core functionality | 4h | 4h |
| Polish & edge cases | 2h | 3h |
| **Total** | **~8h** | **~10h** |

### Limitations

**Option A:**
- Requires running a separate process
- No deep IDE integration
- Limited to browser capabilities

**Option C:**
- VS Code only (excludes other editors)
- Tree view less suitable for "war room" overview
- Extension distribution/maintenance overhead
- VS Code API version tracking required

### User Experience

**Option A:**
- Better for "war room" monitoring (grid layout)
- Works alongside any IDE
- Easy to share screen with team
- Familiar web interface

**Option C:**
- Integrated into existing workflow
- No context switching
- Direct access to terminal/files
- Familiar VS Code patterns

## Recommendation

**Pursue Option A (Web Dashboard)** as the primary visualization solution.

### Rationale

1. **Lower barrier to entry** - No extension installation required, just run a CLI command
2. **Better overview experience** - Grid layout shows more context than tree view
3. **Tool agnostic** - Works with any IDE (VS Code, Cursor, Zed, Neovim, etc.)
4. **Simpler maintenance** - Web standards don't change as often as VS Code API
5. **Shareable** - Easy to show progress on a shared screen or projector

### Future Considerations

The VS Code extension could be offered as an optional enhancement for users who prefer IDE integration. Both approaches share the same underlying state file, so they're compatible.

Potential enhancements:
- Dashboard: Add action buttons (run phase, open PR, view logs)
- Dashboard: Keyboard shortcuts for power users
- Extension: Quick actions in tree view
- Both: Theme support for light/dark modes

## Files Created

### Option A: Web Dashboard
- `dashboard/server.ts` - Hono server with SSE and HTML rendering
- `src/commands/dashboard.ts` - CLI command wrapper
- `bin/cli.ts` - Updated to register dashboard command

### Option C: VS Code Extension
- `vscode-extension/package.json` - Extension manifest
- `vscode-extension/tsconfig.json` - TypeScript configuration
- `vscode-extension/src/extension.ts` - Extension implementation

### Dependencies Added
- `hono` - Web framework
- `@hono/node-server` - Node.js server for Hono
- `chokidar` - File watching
- `open` - Browser launching

## Assumptions Validated

| Assumption | Result |
|------------|--------|
| Hono works without bundler in Node.js ESM | ✅ Confirmed |
| htmx SSE handles state file updates smoothly | ✅ Confirmed |
| chokidar is reliable cross-platform | ✅ Confirmed |
| VS Code TreeDataProvider sufficient for UX | ✅ Works, but less optimal than grid |

## Next Steps

1. **If pursuing Option A:**
   - Add tests for dashboard server
   - Consider adding action buttons
   - Document in user-facing docs

2. **If pursuing Option C:**
   - Package extension for marketplace
   - Add more actions (run phase, etc.)
   - Test on different VS Code versions
