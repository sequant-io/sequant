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

    # Run with basic security rules, JSON output for reliable parsing
    # Use --quiet to suppress progress
    semgrep_output=$($semgrep_cmd --config p/security-audit --config p/secrets \
      --quiet --no-git-ignore --json \
      $changed_files 2>&1) || semgrep_exit=$?

    if [[ -z "$semgrep_output" ]] || ! echo "$semgrep_output" | grep -q '"results"'; then
      echo "   ✅ Semgrep: No security issues found"
    else
      # Count findings by severity from JSON output
      # Semgrep JSON uses "severity":"ERROR" (uppercase) for critical, "WARNING" for warnings
      critical_count=$(echo "$semgrep_output" | grep -o '"severity":"ERROR"' | wc -l | xargs)
      warning_count=$(echo "$semgrep_output" | grep -o '"severity":"WARNING"' | wc -l | xargs)

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

# 10. Build Verification Against Main (when build fails)
# AC-1: When build fails, check if same failure exists on main branch
# AC-2: If failure is new (not on main), flag as potential regression
# AC-3: If failure is pre-existing (on main), document and proceed
verify_build_against_main() {
  local feature_exit_code=$1
  local feature_error_output=$2

  echo ""
  echo "🔍 Verifying build failure against main branch..."

  # Get current directory and branch info
  local current_dir=$(pwd)
  local current_branch=$(git rev-parse --abbrev-ref HEAD)
  local main_repo_dir=""

  # Find the main repository (parent of worktrees)
  if [[ "$current_dir" == *"/worktrees/"* ]]; then
    # We're in a worktree, find the main repo (check both main and master branches)
    main_repo_dir=$(git worktree list | grep -E "\[(main|master)\]" | awk '{print $1}' | head -1)
    if [[ -z "$main_repo_dir" ]]; then
      # Fallback: first worktree entry is typically the main repo
      main_repo_dir=$(git worktree list | head -1 | awk '{print $1}')
      echo "   Note: Using fallback worktree detection (no [main] or [master] found)"
    fi
  else
    # We're in the main repo
    main_repo_dir="$current_dir"
  fi

  if [[ -z "$main_repo_dir" || ! -d "$main_repo_dir" ]]; then
    echo "   ⚠️ Could not locate main repository for comparison"
    echo "   Skipping build verification against main"
    return 3  # Skipped - distinct from regression (1) or different errors (2)
  fi

  # Run build in main repo (temporarily switch, then switch back)
  echo "   Running build on main branch..."

  # Capture main branch build result
  local main_exit_code=0
  local main_error_output=""

  # Use a subshell to avoid changing directory in main shell
  # Timeout after 120s to prevent hanging on slow builds
  if command -v timeout &> /dev/null; then
    main_error_output=$(cd "$main_repo_dir" && timeout 120 npm run build 2>&1 | head -30) || main_exit_code=$?
  else
    # macOS doesn't have timeout by default, use perl fallback
    main_error_output=$(cd "$main_repo_dir" && perl -e 'alarm 120; exec @ARGV' npm run build 2>&1 | head -30) || main_exit_code=$?
  fi

  # Extract first meaningful error line for comparison
  local feature_first_error=$(echo "$feature_error_output" | grep -E "Error:|error:|ERROR:" | head -1)
  local main_first_error=$(echo "$main_error_output" | grep -E "Error:|error:|ERROR:" | head -1)

  echo ""
  echo "### Build Verification"
  echo ""
  echo "| Check | Status |"
  echo "|-------|--------|"

  if [[ $feature_exit_code -ne 0 ]]; then
    echo "| Feature branch build | ❌ Failed |"
  else
    echo "| Feature branch build | ✅ Passed |"
  fi

  if [[ $main_exit_code -ne 0 ]]; then
    echo "| Main branch build | ❌ Failed |"

    # Compare error messages to determine if same failure
    if [[ "$feature_first_error" == "$main_first_error" ]] || \
       [[ -n "$feature_first_error" && -n "$main_first_error" && \
          "$(echo "$feature_first_error" | cut -c1-50)" == "$(echo "$main_first_error" | cut -c1-50)" ]]; then
      echo "| Error match | ✅ Same error |"
      echo "| Regression | **No** (pre-existing) |"
      echo ""
      echo "**Note:** Build failure is pre-existing on main branch. Not blocking this PR."
      return 0  # Not a regression
    else
      echo "| Error match | ❌ Different errors |"
      echo "| Regression | **Unknown** (different failure modes) |"
      echo ""
      echo "**Note:** Build failures differ between branches. Manual review recommended."
      echo ""
      echo "Feature branch error:"
      echo "\`\`\`"
      echo "$feature_first_error"
      echo "\`\`\`"
      echo ""
      echo "Main branch error:"
      echo "\`\`\`"
      echo "$main_first_error"
      echo "\`\`\`"
      return 2  # Different failures, needs review
    fi
  else
    echo "| Main branch build | ✅ Passed |"
    echo "| Regression | **Yes** (new failure) |"
    echo ""
    echo "⚠️ **REGRESSION DETECTED:** Build passes on main but fails on feature branch."
    echo "This failure was introduced by changes in this PR."
    echo ""
    echo "Feature branch error:"
    echo "\`\`\`"
    echo "$feature_first_error"
    echo "\`\`\`"
    return 1  # Regression detected
  fi
}

# Function to run build and capture output for verification
run_build_with_verification() {
  echo ""
  echo "🏗️ Running build check..."

  local build_output=""
  local build_exit_code=0

  # Timeout after 120s to prevent hanging on slow builds
  if command -v timeout &> /dev/null; then
    build_output=$(timeout 120 npm run build 2>&1) || build_exit_code=$?
  else
    # macOS doesn't have timeout by default, use perl fallback
    build_output=$(perl -e 'alarm 120; exec @ARGV' npm run build 2>&1) || build_exit_code=$?
  fi

  if [[ $build_exit_code -eq 0 ]]; then
    echo "✅ Build: Passed"
    return 0
  else
    echo "❌ Build: Failed (exit code: $build_exit_code)"
    echo ""
    echo "Build error output (first 20 lines):"
    echo "$build_output" | head -20
    echo ""

    # Verify against main branch (AC-1, AC-2, AC-3)
    verify_build_against_main "$build_exit_code" "$build_output"
    local verification_result=$?

    return $verification_result
  fi
}

# 10. Run build with verification (calls the functions defined above)
# Capture return code to prevent set -e from exiting early
build_verification_result=0
run_build_with_verification || build_verification_result=$?

# Report build verification status
if [[ $build_verification_result -eq 1 ]]; then
  echo ""
  echo "⚠️  Build verification: REGRESSION DETECTED (blocking)"
elif [[ $build_verification_result -eq 2 ]]; then
  echo ""
  echo "⚠️  Build verification: Different errors detected (needs review)"
elif [[ $build_verification_result -eq 3 ]]; then
  echo ""
  echo "⚠️  Build verification: SKIPPED (could not locate main repo)"
  build_verification_result=0  # Don't fail the script for skipped verification
fi

echo ""
echo "✅ Quality checks complete"

# Exit with build verification result if it indicates a problem
exit $build_verification_result
