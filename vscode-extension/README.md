# Sequant Explorer VS Code Extension

Visualize Sequant workflow state directly in VS Code.

## Quick Start

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode (for development)
npm run watch
```

## Development

1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. In the new window, open a workspace with `.sequant/state.json`
4. The Sequant panel appears in the Activity Bar

## Building VSIX

```bash
# Install vsce if needed
npm install -g @vscode/vsce

# Package
npx vsce package

# Creates sequant-explorer-0.0.1.vsix
```

## Installing VSIX

In VS Code:
1. Cmd+Shift+P → "Extensions: Install from VSIX..."
2. Select the `.vsix` file

Or via CLI:
```bash
code --install-extension sequant-explorer-0.0.1.vsix
```

## Features

- Tree view of issues and phases
- Auto-refresh on state changes
- Open worktree in terminal
- Open issue on GitHub

## Project Structure

```
vscode-extension/
├── package.json      # Extension manifest
├── tsconfig.json     # TypeScript config
├── src/
│   └── extension.ts  # Main extension code
└── out/              # Compiled output (gitignored)
```

## VS Code API Reference

- [TreeDataProvider](https://code.visualstudio.com/api/references/vscode-api#TreeDataProvider)
- [FileSystemWatcher](https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher)
- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
