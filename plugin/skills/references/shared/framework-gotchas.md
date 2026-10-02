# Framework Gotchas

Common framework-specific issues encountered in this project. Check this reference when encountering unexpected runtime errors or build failures.

## AG Grid (v35+)

### Module Registration Required

AG Grid v35 changed to explicit module registration. If you see errors like "Module not registered" or grid features not working:

```typescript
import { ModuleRegistry } from 'ag-grid-community';
import { ClientSideRowModelModule } from 'ag-grid-community';

// Register before using AG Grid components
ModuleRegistry.registerModules([ClientSideRowModelModule]);
```

**Common modules to register:**
- `ClientSideRowModelModule` - Basic row model
- `CsvExportModule` - CSV export functionality
- `InfiniteRowModelModule` - Infinite scrolling

**Docs:** [AG Grid v35 Migration Guide](https://www.ag-grid.com/javascript-data-grid/modules/)

### CSS Import Changes

Styles are now in a separate package. Update imports:

```typescript
// Before v35
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';

// v35+
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';  // New default theme
```

---

## React 19

### use() Hook

React 19 introduces the `use()` hook for reading resources (Promises, Context) during render:

```typescript
// Reading context with use()
function Component() {
  const theme = use(ThemeContext);  // Can be called conditionally
  return <div className={theme} />;
}

// Reading promises with use()
function UserProfile({ userPromise }) {
  const user = use(userPromise);  // Suspends until resolved
  return <div>{user.name}</div>;
}
```

**Gotcha:** `use()` can be called inside loops and conditionals (unlike other hooks).

**Docs:** [React 19 Release Notes](https://react.dev/blog/2024/12/05/react-19)

### Concurrent Features On by Default

Concurrent rendering is now the default. Watch for:
- State updates during render (can cause infinite loops)
- External store subscriptions (use `useSyncExternalStore`)
- Mutable refs during render

---

## Next.js 15

### Changed Caching Defaults

Next.js 15 no longer caches `fetch()` requests by default:

```typescript
// Before Next.js 15 - cached by default
const data = await fetch('/api/data');

// Next.js 15 - NOT cached by default
const data = await fetch('/api/data');  // Always fresh

// To cache, explicitly opt-in:
const data = await fetch('/api/data', { cache: 'force-cache' });

// Or use next.revalidate:
const data = await fetch('/api/data', { next: { revalidate: 3600 } });
```

**Docs:** [Next.js 15 Caching](https://nextjs.org/docs/app/building-your-application/caching)

### Async Request APIs

Dynamic APIs are now async. Update your code:

```typescript
// Before Next.js 15
export default function Page({ params }) {
  const { id } = params;
  // ...
}

// Next.js 15+
export default async function Page({ params }) {
  const { id } = await params;
  // ...
}

// Same for cookies, headers, searchParams
import { cookies, headers } from 'next/headers';

// Before
const cookieStore = cookies();

// After
const cookieStore = await cookies();
```

---

## Tailwind v4

### CSS-First Configuration

Tailwind v4 uses CSS for configuration instead of `tailwind.config.js`:

```css
/* tailwind.css */
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --font-sans: "Inter", sans-serif;
}
```

**Gotcha:** The `@config` directive is removed. Use `@theme` in CSS.

**Docs:** [Tailwind v4 Migration](https://tailwindcss.com/docs/v4-beta)

### Class Syntax Changes

Some utility classes have been renamed or changed:

```html
<!-- v3 -->
<div class="bg-opacity-50">

<!-- v4 - use color modifiers -->
<div class="bg-blue-500/50">
```

---

## Adding New Gotchas

When you encounter a framework-specific issue that cost debugging time, add it here following this template:

```markdown
## [Framework Name] (v[X]+)

### [Issue Title]

[Brief description of the problem and when it occurs]

\`\`\`typescript
// Code example showing the fix or correct approach
\`\`\`

**Gotcha:** [Key insight or common mistake]

**Docs:** [Link to official documentation or changelog]
```

### Guidelines for Adding Entries

1. **Version-specific:** Always include the version where the behavior changed
2. **Code examples:** Show both "before" and "after" when applicable
3. **Link to docs:** Include official documentation or migration guide links
4. **Keep it brief:** Focus on the fix, not the full explanation
5. **Update existing entries:** Prefer updating existing sections over creating duplicates
