#!/bin/bash
# Quality checks script for /qa command
# Run these checks before detailed review

set -e

echo "🔍 Running automated quality checks..."
echo ""

# 1. Type safety check - detect 'any' type usage
type_issues=$(git diff main...HEAD | grep -E ":\s*any[,)]|as any" | wc -l | xargs)
if [[ $type_issues -gt 0 ]]; then
  echo "⚠️  WARNING: $type_issues potential 'any' type usages"
else
  echo "✅ Type safety: No 'any' type additions"
fi

# 2. Deleted tests check
deleted_tests=$(git diff main...HEAD --diff-filter=D --name-only | grep -E "\\.test\\.|\\spec\\." | wc -l | xargs)
if [[ $deleted_tests -gt 0 ]]; then
  echo "❌ BLOCKER: $deleted_tests test files deleted"
else
  echo "✅ Test coverage: No test files deleted"
fi

# 3. Scope check - files changed
files_changed=$(git diff main...HEAD --name-only | wc -l | xargs)
echo "📊 Files changed: $files_changed"

# 4. Size check - LOC added/removed
additions=$(git diff main...HEAD --numstat | awk '{sum+=$1} END {print sum+0}')
deletions=$(git diff main...HEAD --numstat | awk '{sum+=$2} END {print sum+0}')
net_change=$((additions - deletions))
echo "📊 Diff size: +$additions -$deletions (net: $net_change lines)"

# 5. AC proportionality assessment
echo ""
if [[ $net_change -lt 100 ]]; then
  echo "✅ Size: Small change (<100 net LOC)"
elif [[ $net_change -lt 300 ]]; then
  echo "✅ Size: Medium change (100-300 net LOC)"
elif [[ $net_change -lt 500 ]]; then
  echo "⚠️  Size: Large change (300-500 net LOC) - verify proportional to AC"
else
  echo "❌ Size: Very large (>500 net LOC) - may indicate scope creep"
fi

# 6. Database access check (admin pages should use proper access controls)
echo ""
echo "🔒 Checking database access patterns..."
admin_files=$(git diff main...HEAD --name-only | grep -E "^app/admin/" || true)
if [[ -n "$admin_files" ]]; then
  echo "   Admin files modified - manually verify proper database access controls"
  echo "   (admin pages should use service/admin clients, not anonymous clients)"
else
  echo "   No admin files modified"
fi

# 7. Integration check - verify new exports are imported somewhere
echo ""
echo "🔌 Checking integration of new exports..."
new_files=$(git diff main...HEAD --name-only --diff-filter=A | grep -E "\.(ts|tsx)$" || true)
if [[ -n "$new_files" ]]; then
  unintegrated=0
  for file in $new_files; do
    if [[ -f "$file" ]]; then
      exports=$(grep -oE "export (const|function|class|type|interface) ([A-Za-z_][A-Za-z0-9_]*)" "$file" 2>/dev/null | awk '{print $3}' || true)
      for exp in $exports; do
        if [[ -n "$exp" ]]; then
          import_count=$(grep -r "import.*$exp" --include="*.ts" --include="*.tsx" . 2>/dev/null | grep -v "$file" | wc -l | xargs)
          if [[ $import_count -eq 0 ]]; then
            echo "⚠️  WARNING: '$exp' exported from $file but never imported"
            unintegrated=$((unintegrated + 1))
          fi
        fi
      done
    fi
  done
  if [[ $unintegrated -eq 0 ]]; then
    echo "✅ Integration: All exports are imported"
  fi
else
  echo "   No new TypeScript files added"
fi

# 8. Security scan - OWASP vulnerability checks
echo ""
echo "🔒 Running security scan..."
if command -v npx &> /dev/null; then
  npx tsx scripts/lib/__tests__/run-security-scan.ts 2>/dev/null || echo "   Security scanner not available, skipping..."
else
  echo "   npx not available, skipping security scan"
fi

# 9. Semgrep static analysis (optional - graceful skip if not installed)
echo ""
echo "🔍 Running Semgrep static analysis..."

# Check if Semgrep is available
semgrep_available=false
if command -v semgrep &> /dev/null; then
  semgrep_available=true
  semgrep_cmd="semgrep"
elif command -v npx &> /dev/null && npx semgrep --version &> /dev/null 2>&1; then
  semgrep_available=true
  semgrep_cmd="npx semgrep"
fi

if [[ "$semgrep_available" == "true" ]]; then
  # Get changed files for targeted scan
  changed_files=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx|py|go|rs)$' || true)

  if [[ -n "$changed_files" ]]; then
    # Run Semgrep with security rules on changed files
    echo "   Scanning $(echo "$changed_files" | wc -l | xargs) changed file(s)..."

    # Run with basic security rules, output in text format
    # Use --quiet to suppress progress, capture exit code
    semgrep_output=$($semgrep_cmd --config p/security-audit --config p/secrets \
      --quiet --no-git-ignore \
      $changed_files 2>&1) || semgrep_exit=$?

    if [[ -z "$semgrep_output" ]]; then
      echo "   ✅ Semgrep: No security issues found"
    else
      # Count findings by severity
      critical_count=$(echo "$semgrep_output" | grep -c "severity:error" 2>/dev/null || echo "0")
      warning_count=$(echo "$semgrep_output" | grep -c "severity:warning" 2>/dev/null || echo "0")

      if [[ "$critical_count" -gt 0 ]]; then
        echo "   ❌ Semgrep: $critical_count critical finding(s) - REVIEW REQUIRED"
      fi
      if [[ "$warning_count" -gt 0 ]]; then
        echo "   ⚠️  Semgrep: $warning_count warning(s)"
      fi
      if [[ "$critical_count" -eq 0 && "$warning_count" -eq 0 ]]; then
        echo "   ✅ Semgrep: No security issues found"
      fi
    fi
  else
    echo "   No source files changed, skipping Semgrep scan"
  fi
else
  echo "   ⚠️  Semgrep not installed (optional)"
  echo "   Install with: pip install semgrep"
fi

echo ""
echo "✅ Quality checks complete"
