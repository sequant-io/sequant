# Exact Label Matching for Phase Detection

**Quick Start:** Sequant's phase mapper now uses exact label equality instead of substring matching, preventing labels like `"docstring"` from accidentally triggering the docs pipeline.

## What Changed

Previously, phase detection used `label.includes(targetLabel)` to check GitHub issue labels against known label sets. This caused substring collisions where unrelated labels could trigger incorrect workflows:

| Label on Issue | Would Match | Triggered Pipeline | Correct? |
|----------------|-------------|-------------------|----------|
| `docstring`    | `docs`      | Docs (skip spec)  | No       |
| `debugging`    | `bug`       | Bug fix (skip spec)| No       |
| `patchwork`    | `patch`     | Bug fix (skip spec)| No       |
| `webinar`      | `web`       | UI (add test phase)| No       |
| `complexity`   | `complex`   | Quality loop       | No       |
| `insecurity`   | `security`  | Security review    | No       |

Now all label checks use exact equality (`===`), so only labels that exactly match a known value will trigger their associated pipeline.

## Affected Label Sets

All label arrays in the phase mapper use exact matching:

| Label Set | Recognized Labels | Effect |
|-----------|------------------|--------|
| `BUG_LABELS` | `bug`, `fix`, `hotfix`, `patch` | Skip spec phase |
| `DOCS_LABELS` | `docs`, `documentation`, `readme` | Skip spec phase |
| `UI_LABELS` | `ui`, `frontend`, `admin`, `web`, `browser` | Add test phase |
| `COMPLEX_LABELS` | `complex`, `refactor`, `breaking`, `major` | Enable quality loop |
| `SECURITY_LABELS` | `security`, `auth`, `authentication`, `permissions`, `admin` | Add security-review phase |

## Usage

No changes to how you label issues. Labels must now match exactly (case-insensitive) to trigger pipeline behavior. For example:

- `bug` → triggers bug fix pipeline
- `Bug` → triggers bug fix pipeline (case-insensitive)
- `debugging` → does **not** trigger bug fix pipeline
- `docs` → triggers docs pipeline
- `docstring` → does **not** trigger docs pipeline

## Troubleshooting

### Issue isn't getting the expected pipeline

**Symptoms:** An issue with a label like `documentation-update` runs the standard `spec → exec → qa` pipeline instead of the docs shortcut.

**Solution:** Check that the label exactly matches one of the recognized labels listed above. Compound labels like `documentation-update` won't match — use `documentation` instead.

### Phase detection worked before but stopped

**Symptoms:** After upgrading, an issue that previously got a shortened pipeline now gets the full pipeline.

**Solution:** This is likely because the old substring matching was triggering on a partial match. Review the issue's labels and ensure they use one of the exact recognized values.

---

*Generated for Issue #461 on 2026-03-26*
