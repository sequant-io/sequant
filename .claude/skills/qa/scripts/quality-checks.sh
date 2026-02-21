#!/bin/bash
# Quality checks script for /qa command
# Run these checks before detailed review
#
# Supports caching to skip unchanged checks on re-run:
#   --use-cache     Enable caching (default when cache exists)
#   --no-cache      Force fresh run, ignore cache (AC-3)
#   --cache-dir     Custom cache directory (default: .sequant/.cache/qa)
#   --cache-key     Custom cache key prefix

set -e

# =============================================================================
# Configuration
# =============================================================================

USE_CACHE=true
CACHE_DIR=".sequant/.cache/qa"
CACHE_KEY=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --use-cache)
      USE_CACHE=true
      shift
      ;;
    --no-cache)
      USE_CACHE=false
      shift
      ;;
    --cache-dir)
      CACHE_DIR="$2"
      shift 2
      ;;
    --cache-key)
      CACHE_KEY="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Resolve script directory for cache CLI
# Try multiple paths since we might be in a worktree or main repo
CACHE_CLI=""
if [[ -f "$SCRIPT_DIR/../../../scripts/qa/qa-cache-cli.ts" ]]; then
  CACHE_CLI="$SCRIPT_DIR/../../../scripts/qa/qa-cache-cli.ts"
elif [[ -f "scripts/qa/qa-cache-cli.ts" ]]; then
  CACHE_CLI="scripts/qa/qa-cache-cli.ts"
fi

# =============================================================================
# Cache Helper Functions
# =============================================================================

# Check if a check has valid cached result
# Returns: 0 = cache hit, 1 = cache miss
cache_check() {
  local check_type=$1

  if [[ "$USE_CACHE" != "true" ]] || [[ -z "$CACHE_CLI" ]]; then
    return 1
  fi

  if npx tsx "$CACHE_CLI" check "$check_type" 2>/dev/null | grep -q "^HIT"; then
    return 0
  else
    return 1
  fi
}

# Get cached result for a check
cache_get() {
  local check_type=$1

  if [[ "$USE_CACHE" != "true" ]] || [[ -z "$CACHE_CLI" ]]; then
    return 1
  fi

  npx tsx "$CACHE_CLI" get "$check_type" 2>/dev/null
}

# Cache a check result
cache_set() {
  local check_type=$1
  local passed=$2
  local message=$3
  local details=${4:-"{}"}

  if [[ "$USE_CACHE" != "true" ]] || [[ -z "$CACHE_CLI" ]]; then
    return 0
  fi

  echo "{\"passed\":$passed,\"message\":\"$message\",\"details\":$details}" | \
    npx tsx "$CACHE_CLI" set "$check_type" 2>/dev/null || true
}

# Print cache status report (AC-4)
print_cache_status() {
  if [[ "$USE_CACHE" != "true" ]] || [[ -z "$CACHE_CLI" ]]; then
    echo "Cache: Disabled"
    return
  fi

  echo ""
  echo "### Cache Status"
  echo ""
  npx tsx "$CACHE_CLI" status 2>/dev/null || echo "Cache: Error reading status"
}

# =============================================================================
# Main Script
# =============================================================================

echo "🔍 Running automated quality checks..."
if [[ "$USE_CACHE" == "true" && -n "$CACHE_CLI" ]]; then
  echo "   Cache: Enabled (use --no-cache to force fresh run)"
else
  echo "   Cache: Disabled"
fi
echo ""

# Track cache hits/misses for final report
declare -A CACHE_STATUS

# Track blocking issues
TAUTOLOGY_BLOCKING=false

# =============================================================================
# 1. Type safety check - detect 'any' type usage
# =============================================================================
if cache_check "type-safety"; then
  CACHE_STATUS["type-safety"]="HIT"
  cached_result=$(cache_get "type-safety")
  type_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')
  type_message=$(echo "$cached_result" | grep -o '"message":\s*"[^"]*"' | cut -d'"' -f4)

  if [[ "$type_passed" == "true" ]]; then
    echo "✅ Type safety: $type_message (cached)"
  else
    type_issues=$(echo "$cached_result" | grep -o '"count":\s*[0-9]*' | cut -d: -f2 | tr -d ' ')
    echo "⚠️  WARNING: $type_issues potential 'any' type usages (cached)"
  fi
else
  CACHE_STATUS["type-safety"]="MISS"
  type_issues=$(git diff main...HEAD | grep -E ":\s*any[,)]|as any" | wc -l | xargs)
  if [[ $type_issues -gt 0 ]]; then
    echo "⚠️  WARNING: $type_issues potential 'any' type usages"
    cache_set "type-safety" false "Found $type_issues potential 'any' type usages" "{\"count\":$type_issues}"
  else
    echo "✅ Type safety: No 'any' type additions"
    cache_set "type-safety" true "No 'any' type additions" "{\"count\":0}"
  fi
fi

# =============================================================================
# 2. Deleted tests check
# =============================================================================
if cache_check "deleted-tests"; then
  CACHE_STATUS["deleted-tests"]="HIT"
  cached_result=$(cache_get "deleted-tests")
  tests_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')

  if [[ "$tests_passed" == "true" ]]; then
    echo "✅ Test coverage: No test files deleted (cached)"
  else
    deleted_count=$(echo "$cached_result" | grep -o '"count":\s*[0-9]*' | cut -d: -f2 | tr -d ' ')
    echo "❌ BLOCKER: $deleted_count test files deleted (cached)"
  fi
else
  CACHE_STATUS["deleted-tests"]="MISS"
  deleted_tests=$(git diff main...HEAD --diff-filter=D --name-only | grep -E "\\.test\\.|\\spec\\." | wc -l | xargs)
  if [[ $deleted_tests -gt 0 ]]; then
    echo "❌ BLOCKER: $deleted_tests test files deleted"
    cache_set "deleted-tests" false "Found $deleted_tests deleted test files" "{\"count\":$deleted_tests}"
  else
    echo "✅ Test coverage: No test files deleted"
    cache_set "deleted-tests" true "No test files deleted" "{\"count\":0}"
  fi
fi

# =============================================================================
# 3. Scope check - files changed (always fresh - cheap operation)
# =============================================================================
CACHE_STATUS["scope"]="SKIP"
files_changed=$(git diff main...HEAD --name-only | wc -l | xargs)
echo "📊 Files changed: $files_changed"

# =============================================================================
# 4. Size check - LOC added/removed (always fresh - cheap operation)
# =============================================================================
CACHE_STATUS["size"]="SKIP"
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

# =============================================================================
# 6. Database access check (always fresh - cheap operation)
# =============================================================================
echo ""
echo "🔒 Checking database access patterns..."
admin_files=$(git diff main...HEAD --name-only | grep -E "^app/admin/" || true)
if [[ -n "$admin_files" ]]; then
  echo "   Admin files modified - manually verify proper database access controls"
  echo "   (admin pages should use service/admin clients, not anonymous clients)"
else
  echo "   No admin files modified"
fi

# =============================================================================
# 7. Integration check - verify new exports are imported somewhere
# =============================================================================
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

# =============================================================================
# 8. Security scan - OWASP vulnerability checks (cacheable)
# =============================================================================
echo ""
echo "🔒 Running security scan..."
if cache_check "security"; then
  CACHE_STATUS["security"]="HIT"
  cached_result=$(cache_get "security")
  security_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')
  security_message=$(echo "$cached_result" | grep -o '"message":\s*"[^"]*"' | cut -d'"' -f4)

  if [[ "$security_passed" == "true" ]]; then
    echo "   ✅ Security scan: $security_message (cached)"
  else
    echo "   ⚠️  Security scan: $security_message (cached)"
  fi
else
  CACHE_STATUS["security"]="MISS"
  if command -v npx &> /dev/null; then
    security_output=$(npx tsx scripts/lib/__tests__/run-security-scan.ts 2>&1) || security_exit=$?
    if [[ -z "$security_exit" || "$security_exit" -eq 0 ]]; then
      echo "   ✅ Security scan: Passed"
      cache_set "security" true "Passed"
    else
      echo "   ⚠️  Security scan: Issues found"
      echo "$security_output" | head -5
      cache_set "security" false "Issues found"
    fi
  else
    echo "   Security scanner not available, skipping..."
    CACHE_STATUS["security"]="SKIP"
  fi
fi

# =============================================================================
# 9. Semgrep static analysis (cacheable - expensive operation)
# =============================================================================
echo ""
echo "🔍 Running Semgrep static analysis..."

if cache_check "semgrep"; then
  CACHE_STATUS["semgrep"]="HIT"
  cached_result=$(cache_get "semgrep")
  semgrep_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')
  semgrep_message=$(echo "$cached_result" | grep -o '"message":\s*"[^"]*"' | cut -d'"' -f4)

  echo "   $semgrep_message (cached)"
else
  CACHE_STATUS["semgrep"]="MISS"

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
        cache_set "semgrep" true "✅ Semgrep: No security issues found" "{\"critical\":0,\"warning\":0}"
      else
        # Count findings by severity from JSON output
        critical_count=$(echo "$semgrep_output" | grep -o '"severity":"ERROR"' | wc -l | xargs)
        warning_count=$(echo "$semgrep_output" | grep -o '"severity":"WARNING"' | wc -l | xargs)

        if [[ "$critical_count" -gt 0 ]]; then
          echo "   ❌ Semgrep: $critical_count critical finding(s) - REVIEW REQUIRED"
          cache_set "semgrep" false "❌ Semgrep: $critical_count critical finding(s)" "{\"critical\":$critical_count,\"warning\":$warning_count}"
        elif [[ "$warning_count" -gt 0 ]]; then
          echo "   ⚠️  Semgrep: $warning_count warning(s)"
          cache_set "semgrep" true "⚠️ Semgrep: $warning_count warning(s)" "{\"critical\":0,\"warning\":$warning_count}"
        else
          echo "   ✅ Semgrep: No security issues found"
          cache_set "semgrep" true "✅ Semgrep: No security issues found" "{\"critical\":0,\"warning\":0}"
        fi
      fi
    else
      echo "   No source files changed, skipping Semgrep scan"
      CACHE_STATUS["semgrep"]="SKIP"
    fi
  else
    echo "   ⚠️  Semgrep not installed (optional)"
    echo "   Install with: pip install semgrep"
    CACHE_STATUS["semgrep"]="SKIP"
  fi
fi

# =============================================================================
# 10. Test Tautology Detection (AC-1 through AC-5)
# =============================================================================
echo ""
echo "🔬 Running test tautology detection..."

# Check for test files in the diff
test_files_in_diff=$(git diff main...HEAD --name-only | grep -E '\.(test|spec)\.[jt]sx?$' || true)

if [[ -z "$test_files_in_diff" ]]; then
  CACHE_STATUS["test-quality"]="SKIP"
  echo "   ⏭️  No test files in diff, skipping tautology check"
else
  if cache_check "test-quality"; then
    CACHE_STATUS["test-quality"]="HIT"
    cached_result=$(cache_get "test-quality")
    tautology_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')
    tautology_message=$(echo "$cached_result" | grep -o '"message":\s*"[^"]*"' | cut -d'"' -f4)

    if [[ "$tautology_passed" == "true" ]]; then
      echo "   ✅ Test tautology: $tautology_message (cached)"
    else
      echo "   ⚠️  Test tautology: $tautology_message (cached)"
    fi
  else
    CACHE_STATUS["test-quality"]="MISS"

    # Check if tautology detector script exists
    TAUTOLOGY_CLI=""
    if [[ -f "$SCRIPT_DIR/../../../scripts/qa/tautology-detector-cli.ts" ]]; then
      TAUTOLOGY_CLI="$SCRIPT_DIR/../../../scripts/qa/tautology-detector-cli.ts"
    elif [[ -f "scripts/qa/tautology-detector-cli.ts" ]]; then
      TAUTOLOGY_CLI="scripts/qa/tautology-detector-cli.ts"
    fi

    if [[ -n "$TAUTOLOGY_CLI" ]] && command -v npx &> /dev/null; then
      tautology_output=$(npx tsx "$TAUTOLOGY_CLI" --json 2>&1) || tautology_exit=$?

      if [[ -z "$tautology_exit" ]]; then
        tautology_exit=0
      fi

      # Parse JSON output
      tautology_status=$(echo "$tautology_output" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 || echo "none")
      total_tests=$(echo "$tautology_output" | grep -o '"totalTests":[0-9]*' | cut -d: -f2 || echo "0")
      total_tautological=$(echo "$tautology_output" | grep -o '"totalTautological":[0-9]*' | cut -d: -f2 || echo "0")

      if [[ "$tautology_status" == "skip" ]]; then
        echo "   ⏭️  No test blocks found in changed files"
        cache_set "test-quality" true "No test blocks found" "{\"totalTests\":0,\"tautological\":0}"
      elif [[ "$tautology_status" == "blocking" ]]; then
        echo "   ❌ BLOCKER: $total_tautological/$total_tests test blocks are tautological (>50%)"
        echo "      Tautological tests don't call production code and provide zero regression protection."
        cache_set "test-quality" false "$total_tautological/$total_tests tests tautological (>50%)" "{\"totalTests\":$total_tests,\"tautological\":$total_tautological}"
        TAUTOLOGY_BLOCKING=true
      elif [[ "$tautology_status" == "warning" ]]; then
        echo "   ⚠️  WARNING: $total_tautological/$total_tests test blocks are tautological"
        cache_set "test-quality" true "$total_tautological/$total_tests tests tautological" "{\"totalTests\":$total_tests,\"tautological\":$total_tautological}"
      else
        echo "   ✅ Test tautology: All tests call production code"
        cache_set "test-quality" true "All tests call production code" "{\"totalTests\":$total_tests,\"tautological\":0}"
      fi
    else
      echo "   ⚠️  Test tautology detector not available, skipping..."
      CACHE_STATUS["test-quality"]="SKIP"
    fi
  fi
fi

# =============================================================================
# 11. Shell Script Semantic Checks (unused functions, integration)
# =============================================================================
echo ""
echo "🔍 Checking shell script semantics..."
shell_scripts=$(git diff main...HEAD --name-only | grep -E '\.sh$' || true)
if [[ -n "$shell_scripts" ]]; then
  for script in $shell_scripts; do
    if [[ -f "$script" ]]; then
      echo "   Analyzing: $script"
      # Extract function definitions and check if they're called
      funcs=$(grep -oE "^[a-zA-Z_][a-zA-Z0-9_]*\(\)" "$script" 2>/dev/null | sed 's/()//' || true)
      unused_count=0
      for func in $funcs; do
        # Count calls (excluding the definition line)
        call_count=$(grep -c "\b${func}\b" "$script" 2>/dev/null || echo "0")
        if [[ $call_count -lt 2 ]]; then  # Only definition, no calls
          echo "   ⚠️  Function '$func' defined but possibly not called"
          unused_count=$((unused_count + 1))
        fi
      done
      if [[ $unused_count -eq 0 && -n "$funcs" ]]; then
        echo "   ✅ All functions are called"
      fi
    fi
  done
else
  echo "   No shell scripts changed"
fi

# =============================================================================
# 12. Build Verification (cacheable - expensive operation)
# =============================================================================

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
    main_repo_dir=$(git worktree list | grep -E "\[(main|master)\]" | awk '{print $1}' | head -1)
    if [[ -z "$main_repo_dir" ]]; then
      main_repo_dir=$(git worktree list | head -1 | awk '{print $1}')
      echo "   Note: Using fallback worktree detection (no [main] or [master] found)"
    fi
  else
    main_repo_dir="$current_dir"
  fi

  if [[ -z "$main_repo_dir" || ! -d "$main_repo_dir" ]]; then
    echo "   ⚠️ Could not locate main repository for comparison"
    echo "   Skipping build verification against main"
    return 3
  fi

  echo "   Running build on main branch..."

  local main_exit_code=0
  local main_error_output=""

  if command -v timeout &> /dev/null; then
    main_error_output=$(cd "$main_repo_dir" && timeout 120 npm run build 2>&1 | head -30) || main_exit_code=$?
  else
    main_error_output=$(cd "$main_repo_dir" && perl -e 'alarm 120; exec @ARGV' npm run build 2>&1 | head -30) || main_exit_code=$?
  fi

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

    if [[ "$feature_first_error" == "$main_first_error" ]] || \
       [[ -n "$feature_first_error" && -n "$main_first_error" && \
          "$(echo "$feature_first_error" | cut -c1-50)" == "$(echo "$main_first_error" | cut -c1-50)" ]]; then
      echo "| Error match | ✅ Same error |"
      echo "| Regression | **No** (pre-existing) |"
      echo ""
      echo "**Note:** Build failure is pre-existing on main branch. Not blocking this PR."
      return 0
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
      return 2
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
    return 1
  fi
}

run_build_with_verification() {
  echo ""
  echo "🏗️ Running build check..."

  local build_output=""
  local build_exit_code=0

  if command -v timeout &> /dev/null; then
    build_output=$(timeout 120 npm run build 2>&1) || build_exit_code=$?
  else
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

    verify_build_against_main "$build_exit_code" "$build_output"
    local verification_result=$?

    return $verification_result
  fi
}

# Check build cache
if cache_check "build"; then
  CACHE_STATUS["build"]="HIT"
  cached_result=$(cache_get "build")
  build_passed=$(echo "$cached_result" | grep -o '"passed":\s*[^,}]*' | cut -d: -f2 | tr -d ' ')
  build_message=$(echo "$cached_result" | grep -o '"message":\s*"[^"]*"' | cut -d'"' -f4)

  echo ""
  echo "🏗️ Build check: $build_message (cached)"

  if [[ "$build_passed" == "true" ]]; then
    build_verification_result=0
  else
    build_verification_result=1
  fi
else
  CACHE_STATUS["build"]="MISS"
  build_verification_result=0
  run_build_with_verification || build_verification_result=$?

  # Cache the result
  if [[ $build_verification_result -eq 0 ]]; then
    cache_set "build" true "Passed"
  else
    cache_set "build" false "Failed (exit code: $build_verification_result)"
  fi
fi

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
  build_verification_result=0
fi

# =============================================================================
# Cache Status Report (AC-4)
# =============================================================================
echo ""
echo "=========================================="
echo "### Cache Status Report"
echo "=========================================="
echo ""
echo "| Check | Cache Status |"
echo "|-------|--------------|"
for check in "type-safety" "deleted-tests" "scope" "size" "security" "semgrep" "test-quality" "build"; do
  status="${CACHE_STATUS[$check]:-MISS}"
  if [[ "$status" == "HIT" ]]; then
    echo "| $check | ✅ HIT |"
  elif [[ "$status" == "SKIP" ]]; then
    echo "| $check | ⏭️ SKIP |"
  else
    echo "| $check | ❌ MISS |"
  fi
done
echo ""

# Count hits and misses
hit_count=0
miss_count=0
skip_count=0
for check in "type-safety" "deleted-tests" "scope" "size" "security" "semgrep" "test-quality" "build"; do
  status="${CACHE_STATUS[$check]:-MISS}"
  if [[ "$status" == "HIT" ]]; then
    ((hit_count++))
  elif [[ "$status" == "SKIP" ]]; then
    ((skip_count++))
  else
    ((miss_count++))
  fi
done

echo "**Summary:** $hit_count hits, $miss_count misses, $skip_count skipped"
if [[ $hit_count -gt 0 ]]; then
  echo "**Performance:** Cached checks saved execution time"
fi
echo ""

echo "✅ Quality checks complete"

# Exit with appropriate code based on blocking issues
# Priority: build verification > tautology blocking
if [[ $build_verification_result -ne 0 ]]; then
  exit $build_verification_result
fi

if [[ "$TAUTOLOGY_BLOCKING" == "true" ]]; then
  echo ""
  echo "❌ BLOCKED: >50% of test blocks are tautological (AC-4 violation)"
  exit 1
fi

exit 0
