# Documentation Tiers

Organize information by access frequency:

## Tier 1: Hot Path (CLAUDE.md)

- Used in 50%+ of sessions
- Core architecture decisions
- Most common commands and patterns
- **Target: 700-800 lines** (check with `wc -l CLAUDE.md`)
- Quick summaries with links to detailed docs
- Review monthly

**Keep in CLAUDE.md:**
- ✅ Core architecture patterns (database, routing, components)
- ✅ Most common commands (development, discovery, enrichment)
- ✅ Critical patterns (validation, audit logging, state management)
- ✅ Quick reference information needed in 50%+ of sessions

## Tier 2: Reference (docs/ folder)

- Used in 10-50% of sessions
- Detailed specs, schemas, guides
- Can be 1000+ lines per doc
- Review quarterly

**Current specialized docs:**
- `CITY_COVERAGE.md` - Coverage analysis workflow
- `SHOP_DISCOVERY.md` - Discovery & enrichment pipeline
- `TESTING.md` - UI testing patterns
- `ADMIN_CMS_ARCHITECTURE.md` - Full CMS architecture

## Tier 3: Archive (docs/archive/)

- Used in <10% of sessions
- Historical context, deprecated patterns
- Move here after 6 months of non-use
- Keep for searchability, not active use

## Tier 4: Code Comments

- Implementation-specific details
- Edge case handling
- Why certain approaches were chosen
- Lives with the code, not in docs

## When to Extract to Separate Docs

Move from CLAUDE.md to docs/ when:
- ✅ Section exceeds 50 lines
- ✅ Contains detailed workflow steps (>3 steps)
- ✅ Has extensive examples or command variations
- ✅ Used occasionally but not in every session
- ✅ Could evolve independently

## Documentation Health Metrics

**CLAUDE.md Health Check:**
- Current line count vs target (700-800)
- Lines added in last month
- Sections that feel bloated
- Sections that are missing
- Redundancy between CLAUDE.md and docs/

**Recommendations:**
- **Prune:** >900 lines, multiple bloated sections
- **Expand:** <600 lines, missing critical patterns
- **Restructure:** Hard to find information
- **Extract:** Multiple sections >50 lines
- **Good as-is:** 700-800 lines, balanced content
