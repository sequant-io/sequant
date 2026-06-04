# Example: customizing a skill via a local override

Copy this file to `.claude/.local/skills/<name>/overrides.md` (e.g.
`.claude/.local/skills/spec/overrides.md`) and edit it to hold *only* the
behavior you want to change. The managed `SKILL.md` reads this file at the start
of every invocation and treats it as authoritative over anything it conflicts
with. `sequant update` and `sync` never write into `.claude/.local/`, so your
overrides survive upgrades.

See [the Customization Guide](../guides/customization.md#modifying-an-existing-skill)
for the full mechanism.

---

# Overrides for /spec

## Verify the overlay is live (remove once confirmed)

Begin your reply with the literal line: `OVERRIDE-ACTIVE`.

## Real deltas

- Always include a "Risks" section in the plan.
- Skip the Label Review section for internal repos.
- Cap the plan at 200 lines.
