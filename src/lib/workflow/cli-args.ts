/**
 * CLI Argument Parser for Pipeline Scripts
 *
 * Typed argument parsing with support for common flags used across all scripts.
 *
 * @example
 * ```typescript
 * import { parseArgs } from './lib/cli-args'
 *
 * const args = parseArgs(process.argv.slice(2))
 * console.log(args.city)    // 'nashville'
 * console.log(args.limit)   // 10
 * console.log(args.dryRun)  // true
 * ```
 */

/**
 * Parsed command line arguments with typed fields.
 */
export interface ParsedArgs {
  /** City slug (e.g., 'nashville', 'new-york') */
  city?: string
  /** Limit for number of items to process */
  limit?: number
  /** Dry run mode - no database writes */
  dryRun: boolean
  /** Verbose mode - enable debug logging */
  verbose: boolean
  /** Auto-confirm prompts (skip confirmation) */
  yes: boolean
  /** Positional arguments (non-flag arguments) */
  positional: string[]
  /** Any additional named arguments */
  [key: string]: string | number | boolean | string[] | undefined
}

/**
 * Default values for parsed arguments.
 */
export interface ParseDefaults {
  city?: string
  limit?: number
  dryRun?: boolean
  verbose?: boolean
  yes?: boolean
}

/**
 * Parse command line arguments into a typed object.
 *
 * Supports two flag formats:
 * - `--flag=value` (equals format)
 * - `--flag value` (space-separated format)
 *
 * Boolean flags:
 * - `--dry-run` or `--dryRun` → dryRun: true
 * - `--verbose` or `-v` → verbose: true
 * - `--yes` or `-y` → yes: true
 *
 * @param argv - Command line arguments (typically `process.argv.slice(2)`)
 * @param defaults - Optional default values
 * @returns Parsed arguments object
 *
 * @example
 * ```typescript
 * // With default city
 * const args = parseArgs(['--limit', '5'], { city: 'nashville' })
 * // args.city === 'nashville'
 * // args.limit === 5
 *
 * // Boolean flags
 * const args2 = parseArgs(['--dry-run', '--verbose'])
 * // args2.dryRun === true
 * // args2.verbose === true
 * ```
 */
export function parseArgs(argv: string[], defaults?: ParseDefaults): ParsedArgs {
  const result: ParsedArgs = {
    city: defaults?.city,
    limit: defaults?.limit,
    dryRun: defaults?.dryRun ?? false,
    verbose: defaults?.verbose ?? false,
    yes: defaults?.yes ?? false,
    positional: [],
  }

  let i = 0
  while (i < argv.length) {
    const arg = argv[i]

    // Boolean flags (no value)
    if (arg === '--dry-run' || arg === '--dryRun') {
      result.dryRun = true
      i++
      continue
    }

    if (arg === '--verbose' || arg === '-v') {
      result.verbose = true
      i++
      continue
    }

    if (arg === '--yes' || arg === '-y') {
      result.yes = true
      i++
      continue
    }

    // Handle --flag=value format
    if (arg.startsWith('--') && arg.includes('=')) {
      const equalsIndex = arg.indexOf('=')
      const key = arg.slice(2, equalsIndex)
      const value = arg.slice(equalsIndex + 1)
      const normalizedKey = normalizeKey(key)
      result[normalizedKey] = parseValue(normalizedKey, value)
      i++
      continue
    }

    // Handle --flag value format
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const normalizedKey = normalizeKey(key)
      const nextArg = argv[i + 1]

      // Check if next argument exists and is not another flag
      if (nextArg !== undefined && !nextArg.startsWith('-')) {
        result[normalizedKey] = parseValue(normalizedKey, nextArg)
        i += 2
      } else {
        // Treat as boolean flag
        result[normalizedKey] = true
        i++
      }
      continue
    }

    // Handle short flags like -v, -y (already handled above)
    if (arg.startsWith('-') && arg.length === 2) {
      i++
      continue
    }

    // Positional argument
    result.positional.push(arg)
    i++
  }

  return result
}

/**
 * Normalize a flag key to camelCase.
 * Converts kebab-case to camelCase (e.g., 'dry-run' → 'dryRun').
 *
 * @param key - The flag key to normalize
 * @returns Normalized key in camelCase
 */
export function normalizeKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Parse a value based on expected type for known keys.
 * Numbers are parsed for 'limit', 'count', 'max', 'min', 'timeout'.
 *
 * @param key - The normalized key
 * @param value - The string value
 * @returns Parsed value (number or string)
 */
export function parseValue(key: string, value: string): string | number {
  const numericKeys = ['limit', 'count', 'max', 'min', 'timeout', 'since', 'days']

  if (numericKeys.includes(key)) {
    const parsed = parseInt(value, 10)
    return isNaN(parsed) ? value : parsed
  }

  return value
}

/**
 * Get a required string argument, throwing an error if missing.
 *
 * @param args - Parsed arguments
 * @param key - Argument key to get
 * @param errorMessage - Custom error message if missing
 * @returns The argument value
 * @throws Error if argument is missing
 *
 * @example
 * ```typescript
 * const city = getRequiredArg(args, 'city', 'Missing required --city argument')
 * ```
 */
export function getRequiredArg(
  args: ParsedArgs,
  key: keyof ParsedArgs | string,
  errorMessage?: string
): string {
  const value = args[key]

  if (value === undefined || value === '') {
    throw new Error(errorMessage ?? `Missing required argument: --${key}`)
  }

  if (typeof value !== 'string') {
    throw new Error(`Argument --${key} must be a string`)
  }

  return value
}

/**
 * Check if help was requested via --help or -h flag.
 *
 * @param argv - Command line arguments
 * @returns True if help was requested
 */
export function isHelpRequested(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

/**
 * Print usage information for a script.
 *
 * @param scriptName - Name of the script
 * @param description - Brief description
 * @param options - Available options with descriptions
 * @param examples - Usage examples
 *
 * @example
 * ```typescript
 * if (isHelpRequested(process.argv)) {
 *   printUsage('discover-shops', 'Discover matcha shops for a city', {
 *     '--city <slug>': 'City slug (required)',
 *     '--limit <n>': 'Limit API calls',
 *     '--dry-run': 'Preview mode, no database writes',
 *   }, [
 *     'npx tsx scripts/discover-shops.ts --city nashville',
 *     'npx tsx scripts/discover-shops.ts --city nashville --limit 5',
 *   ])
 *   process.exit(0)
 * }
 * ```
 */
export function printUsage(
  scriptName: string,
  description: string,
  options: Record<string, string>,
  examples?: string[]
): void {
  console.log(`\n${scriptName}`)
  console.log(`${'─'.repeat(scriptName.length)}\n`)
  console.log(description)
  console.log('\nOptions:')

  const maxKeyLen = Math.max(...Object.keys(options).map(k => k.length))

  for (const [key, desc] of Object.entries(options)) {
    console.log(`  ${key.padEnd(maxKeyLen + 2)} ${desc}`)
  }

  if (examples && examples.length > 0) {
    console.log('\nExamples:')
    for (const example of examples) {
      console.log(`  ${example}`)
    }
  }

  console.log('')
}
