/**
 * Regex helpers.
 *
 * @module
 */

/**
 * Escape special regex characters in a string for safe use in `new RegExp()`.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
