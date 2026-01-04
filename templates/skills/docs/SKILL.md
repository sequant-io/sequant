---
name: docs
description: "Phase 4 - Generate admin-facing documentation for implemented features before merging."
license: MIT
metadata:
  author: matcha-maps
  version: "1.0"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
---

# Documentation Generator

You are the Phase 4 "Documentation Agent" for the Matcha Maps repository.

## Purpose

When invoked as `/docs`, your job is to:

1. Analyze the implemented feature (from PR diff or git diff).
2. Generate operational documentation (how to use, not how it works).
3. Create documentation in the appropriate folder (`docs/admin/` or `docs/features/`).
4. Post a summary comment to the GitHub issue.

## Behavior

Invocation:

- `/docs 123`:
  - Treat `123` as the GitHub issue number.
  - Analyze the implementation to understand what was built.
  - Generate admin-facing or user-facing documentation.

### 1. Gather Context

**Step 1:** Read the GitHub issue and comments for feature context:
```bash
gh issue view <issue-number> --json title,body,labels --repo admarble/matcha-maps
```

**Step 2:** Check for existing PR:
```bash
gh pr list --search "head:feature/<issue-number>" --json number,headRefName --repo admarble/matcha-maps
```

**Step 3:** Analyze the implementation diff:
```bash
# If PR exists:
gh pr diff <pr-number> --repo admarble/matcha-maps

# If no PR, use git diff from feature branch:
git diff main...HEAD --name-only
git diff main...HEAD
```

### 2. Auto-Detect Documentation Type

Determine documentation type based on changed files:

**Admin Documentation** (`docs/admin/`):
- Files in `app/admin/`
- Files in `components/admin/`
- Files in `lib/admin/`
- Admin-related API routes

**User-Facing Documentation** (`docs/features/`):
- Files in `app/[city]/`
- Files in `components/` (non-admin)
- Public-facing pages or features

**Decision Logic:**
```
IF any file path contains "/admin/" THEN
  type = "admin"
  output_dir = "docs/admin/"
ELSE
  type = "feature"
  output_dir = "docs/features/"
END IF
```

### 3. Documentation Template

Generate documentation using this template:

```markdown
# [Feature Name]

**Quick Start:** [1-2 sentence summary of what this feature does and why to use it]

## Access

- **URL:** `/admin/[route]` or `/[route]`
- **Menu:** Admin → [Section] → [Feature]
- **Permissions:** [Required role or access level]

## Usage

### [Primary Action]

1. Navigate to [location]
2. [Step 2...]
3. [Step 3...]

### [Secondary Action] (if applicable)

1. [Steps...]

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| [Option 1] | [What it does] | [Default value] |
| [Option 2] | [What it does] | [Default value] |

## Common Workflows

### [Workflow 1: e.g., "Review and Approve Shops"]

1. [Step 1]
2. [Step 2]
3. [Step 3]

### [Workflow 2: e.g., "Bulk Edit Multiple Items"]

1. [Step 1]
2. [Step 2]

## Troubleshooting

### [Common Issue 1]

**Symptoms:** [What the user sees]

**Solution:** [How to fix it]

### [Common Issue 2]

**Symptoms:** [What the user sees]

**Solution:** [How to fix it]

---

*Generated for Issue #[number] on [date]*
```

### 4. Content Guidelines

**Focus on operational usage, not technical implementation:**

- "Click the 'Approve' button to publish the shop"
- NOT: "The `approveShop` function updates the database"

- "Wait for the green success message"
- NOT: "The API returns a 200 status code"

**Be specific and actionable:**

- "Navigate to Admin → Shops → Review Queue"
- NOT: "Go to the review page"

**Include visual cues when relevant:**

- "Look for the blue 'Edit' icon next to each row"
- NOT: "Click the edit button"

**Document common workflows end-to-end:**

- "To approve a shop: 1. Open Review Queue, 2. Click shop name, 3. Review details in each tab, 4. Click Approve"
- NOT: "Use the approve button to approve shops"

### 5. File Naming Convention

Generate filename from feature name:
- Use lowercase with hyphens
- Be descriptive but concise
- Match the primary feature purpose

Examples:
- `shop-review-queue.md` - For shop review admin page
- `bulk-edit-operations.md` - For bulk editing feature
- `city-configuration.md` - For city config admin
- `matcha-maps-gallery.md` - For maps gallery feature

### 6. Output and Summary

After generating documentation:

1. **Create the documentation file:**
   - Write to `docs/admin/[feature-name].md` or `docs/features/[feature-name].md`
   - Ensure directory exists (create with `.gitkeep` if needed)

2. **Post summary comment to GitHub issue:**
   ```bash
   gh issue comment <issue-number> --body "$(cat <<'EOF'
   ## Documentation Generated

   **File:** `docs/[admin|features]/[filename].md`

   ### Sections Included:
   - Quick Start
   - Access (URL, menu, permissions)
   - Usage (step-by-step workflows)
   - Options & Settings
   - Common Workflows
   - Troubleshooting

   ### Next Steps:
   1. Review generated documentation for accuracy
   2. Add screenshots if helpful (optional)
   3. Merge PR to deploy documentation

   ---
   Ready to merge!
   EOF
   )"
   ```

### 7. Quality Checklist

Before completing, verify:

- [ ] Documentation is operational (how to use, not how it works)
- [ ] All user-facing actions are documented
- [ ] Steps are numbered and specific
- [ ] Options/settings are in table format
- [ ] At least 1-2 troubleshooting items included
- [ ] Filename follows naming convention
- [ ] Correct folder (`docs/admin/` vs `docs/features/`)
- [ ] Summary comment posted to issue

## Workflow Integration

The `/docs` command is the final step before merging:

```
/spec → /exec → /test (optional) → /qa → /docs
```

**After /qa passes:**
- Run `/docs <issue>` to generate feature documentation
- Review generated docs for accuracy
- Add screenshots if helpful
- Merge PR

## Example Output

For Issue #180 (City Configuration UI):

**File:** `docs/admin/city-configuration.md`

```markdown
# City Configuration

**Quick Start:** Add and manage cities in Matcha Maps through the Admin CMS. Use this to expand coverage to new cities or update existing city settings.

## Access

- **URL:** `/admin/cities`
- **Menu:** Admin → Cities
- **Permissions:** Admin access required

## Usage

### Adding a New City

1. Navigate to Admin → Cities
2. Click the "Add City" button (top right)
3. Complete the 4-step wizard:
   - **Step 1 - Basic Info:** Enter city name, state, and select status
   - **Step 2 - Geography:** Set center coordinates and map bounds
   - **Step 3 - Discovery:** Configure shop discovery settings
   - **Step 4 - Review:** Confirm all settings
4. Click "Create City" to save

### Editing an Existing City

1. Navigate to Admin → Cities
2. Click on the city card to open details
3. Click "Edit" in the Config tab
4. Update settings as needed
5. Click "Save Changes"

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| Status | City visibility (active, in_development, coming_soon) | in_development |
| Timezone | City timezone for hours display | America/New_York |
| Map Bounds | Visible area on city map | Auto-calculated |

## Common Workflows

### Launch a New City

1. Add city via wizard (status: in_development)
2. Run shop discovery scripts
3. Review and approve shops in Review Queue
4. Change city status to "active"
5. City appears on homepage

## Troubleshooting

### City doesn't appear on homepage

**Symptoms:** City was added but doesn't show in city selector

**Solution:** Check city status is set to "active" in Admin → Cities → [City] → Config

---

*Generated for Issue #180 on 2025-11-25*
```
