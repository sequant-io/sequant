# Next.js Stack Guide

This guide covers using Sequant with Next.js / React projects.

## Detection

Sequant automatically detects Next.js projects by looking for:

- `next.config.js`
- `next.config.mjs`
- `next.config.ts`
- `next` in `package.json` dependencies

## Default Commands

When initialized with the Next.js stack, Sequant configures these commands:

| Command | Default |
|---------|---------|
| Test | `npm test` |
| Build | `npm run build` |
| Lint | `npm run lint` |
| Dev | `npm run dev` |

## File Patterns

The workflow skills use these patterns to locate files:

| Pattern | Glob |
|---------|------|
| Components | `components/**/*.tsx` |
| Pages/Routes | `app/**/*.tsx` |
| API Routes | `app/api/**/*.ts` |
| Tests | `__tests__/**/*.test.{ts,tsx}` |

## Workflow Integration

### /spec Phase

During planning, Sequant will:
- Check for existing components in `components/`
- Look for similar pages in `app/`
- Review API patterns in `app/api/`

### /exec Phase

During implementation, the agent will:
- Run `npm run lint` to check code style
- Run `npm test` for test verification
- Run `npm run build` to verify the build passes

### /qa Phase

Quality review includes:
- TypeScript type checking
- ESLint validation
- Build verification
- Test coverage review

## Customization

Override commands in `.claude/.local/memory/constitution.md`:

```markdown
## Build Commands

- Test: `npm run test:ci`
- Build: `npm run build:prod`
- Lint: `npm run lint:strict`
```

## Common Patterns

### App Router (Next.js 13+)

```
app/
├── layout.tsx
├── page.tsx
├── api/
│   └── route.ts
└── [slug]/
    └── page.tsx
```

### Components

```
components/
├── ui/           # Reusable UI components
├── forms/        # Form components
└── layouts/      # Layout components
```

## Tips

1. **Use Server Components by default** - The agent will prefer server components unless client interactivity is needed.

2. **API Routes** - For data fetching, prefer server actions or API routes in `app/api/`.

3. **Testing** - Ensure Jest or Vitest is configured for the `/test` phase to work properly.

## See Also

- [Customization Guide](../customization.md)
- [Troubleshooting](../troubleshooting.md)
