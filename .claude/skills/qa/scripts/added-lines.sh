#!/usr/bin/env bash
# Prints the added lines of a unified diff read from stdin, without the leading "+".
# Lives in a script, not inline in SKILL.md: Claude Code substitutes $0 in skill
# text when the skill is invoked with arguments (#1289).
awk '/^\+[^+]/ { print substr($0, 2) }'
