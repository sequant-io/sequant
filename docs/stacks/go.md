# Go Stack Guide

This guide covers using Sequant with Go projects.

## Detection

Sequant automatically detects Go projects by looking for:

- `go.mod`

## Default Commands

When initialized with the Go stack, Sequant configures these commands:

| Command | Default |
|---------|---------|
| Test | `go test ./...` |
| Build | `go build ./...` |
| Lint | `golangci-lint run` |
| Format | `go fmt ./...` |

## File Patterns

The workflow skills use these patterns to locate files:

| Pattern | Glob |
|---------|------|
| Source | `**/*.go` |
| Tests | `**/*_test.go` |

## Workflow Integration

### /spec Phase

During planning, Sequant will:
- Review package structure
- Check existing interfaces and types
- Look for test patterns in `*_test.go` files

### /exec Phase

During implementation, the agent will:
- Run `golangci-lint run` for linting
- Run `go test ./...` for verification
- Run `go build ./...` to ensure it compiles

### /qa Phase

Quality review includes:
- golangci-lint checks
- Go vet analysis
- Test coverage review
- Race condition detection (`-race`)

## Customization

Override commands in `.claude/.local/memory/constitution.md`:

```markdown
## Build Commands

- Test: `go test -v -race ./...`
- Build: `go build -o bin/ ./cmd/...`
- Lint: `golangci-lint run --enable-all`
```

## Common Patterns

### Standard Layout

```
cmd/
└── myapp/
    └── main.go
internal/
├── config/
├── handlers/
└── models/
pkg/
└── utils/
go.mod
go.sum
```

### Simple Binary

```
main.go
config.go
handlers.go
handlers_test.go
go.mod
```

### Library

```
mylib.go
mylib_test.go
internal/
└── helpers.go
go.mod
```

## Tips

1. **Use `golangci-lint`** - Install it for comprehensive linting. Sequant expects it by default.

2. **Table-Driven Tests** - The agent will follow Go conventions for table-driven tests.

3. **Interfaces** - Define interfaces where consumers need them, not where implementations live.

4. **Error Handling** - Use error wrapping with `fmt.Errorf("context: %w", err)` for better debugging.

5. **Packages** - Keep package names short and lowercase; avoid stuttering (e.g., `http.HTTPClient`).

## golangci-lint Configuration

Create `.golangci.yml` for custom linting:

```yaml
linters:
  enable:
    - gofmt
    - govet
    - errcheck
    - staticcheck
    - gosimple
    - ineffassign
    - unused

linters-settings:
  govet:
    check-shadowing: true
```

## See Also

- [Customization Guide](../customization.md)
- [Troubleshooting](../troubleshooting.md)
