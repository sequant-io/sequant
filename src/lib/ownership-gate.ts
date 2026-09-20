/**
 * Per-site `writeFile(` scan behind the ownership gate's side (b) (#1090, #1106).
 *
 * Pure string-in / sites-out so a synthetic source needs no filesystem. Every
 * `writeFile(` call — awaited, `void`ed, bare or `fs.writeFile` — is one site,
 * attributed to the innermost named function that contains it (declaration,
 * `const f = async () => {}` or `const f = function () {}`) and keyed by the
 * destination expression it writes, so a second write to a new destination
 * inside an already-registered function has no registry entry.
 *
 * Deliberately not a TypeScript AST walk: this is a dev-time gate and a
 * comment/string-aware scanner is enough, provided the caller cross-checks the
 * site count against a naive `/\bwriteFile\s*\(/g` count of the same file.
 * Class and object methods are not recognised as scopes; a writer declared that
 * way inherits the enclosing named function (or `(top-level)`).
 */

export interface WriteSite {
  file: string;
  /** Enclosing named function, or `(top-level)`. */
  fn: string;
  /** First argument of the call, whitespace-normalised. */
  destExpr: string;
  /** 1-based line of the `writeFile(` token. */
  line: number;
  /** `file#fn` — for messages. */
  site: string;
  /** `file#fn#destExpr` — the registry key. */
  key: string;
}

export interface WriteSiteCheck {
  /** Sites whose `file#fn#destExpr` key is absent from the registry. */
  undeclaredSites: WriteSite[];
  /** Registry destinations that are neither declared nor template-routed. */
  undeclaredDestinations: { key: string; destination: string }[];
}

const REGEX_PREV = new Set([..."(,=:[!&|?{};+-*%<>~^"]);

/**
 * Blank out comments and the contents of string, template and regex literals
 * (newlines and length preserved) so brace/paren counting cannot be fooled.
 */
function mask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = c;
    } else if (c === "/" && (prev === "" || REGEX_PREV.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[" || src[j] === "]") {
          inClass = src[j] === "[";
          j++;
        } else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
      prev = "/";
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out.join("");
}

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(m: string, open: number): number {
  let depth = 0;
  for (let k = open; k < m.length; k++) {
    if (m[k] === "{") depth++;
    else if (m[k] === "}" && --depth === 0) return k + 1;
  }
  return m.length;
}

interface Scope {
  name: string;
  start: number;
  end: number;
}

/**
 * From `from` (just after a declaration's name), locate the body. `needArrow`
 * marks the `const f = (…)` form, which only counts as a function if a `=>`
 * follows the parameter list.
 */
function findBody(
  m: string,
  from: number,
  needArrow: boolean,
): { start: number; end: number } | undefined {
  let paren = 0;
  let angle = 0;
  let arrow = !needArrow;
  for (let k = from; k < m.length; k++) {
    const c = m[k];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (paren === 0 && c === "<") angle++;
    else if (paren === 0 && c === ">" && m[k - 1] !== "=" && angle > 0) angle--;
    else if (paren === 0 && c === "=" && m[k + 1] === ">") {
      arrow = true;
      angle = 0;
      k++;
      // Expression-bodied arrow: scope runs to the end of the statement.
      const rest = /\S/.exec(m.slice(k + 1));
      if (rest && m[k + 1 + rest.index] !== "{") {
        let depth = 0;
        for (let e = k + 1; e < m.length; e++) {
          if ("([{".includes(m[e])) depth++;
          else if (")]}".includes(m[e]) && --depth < 0) {
            return { start: k + 1, end: e };
          } else if ((m[e] === ";" || m[e] === ",") && depth === 0) {
            return { start: k + 1, end: e };
          }
        }
        return { start: k + 1, end: m.length };
      }
    } else if (paren === 0 && angle === 0 && c === "{" && arrow) {
      return { start: k, end: matchBrace(m, k) };
    } else if (paren === 0 && c === ";") {
      return undefined;
    }
  }
  return undefined;
}

function findScopes(m: string): Scope[] {
  const scopes: Scope[] = [];
  const declaration =
    /\bfunction\s*\*?\s+(\w+)|\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]+)?=\s*(?:async\s+)?(function\b|(?=\(|\w+\s*=>))/g;
  for (const d of m.matchAll(declaration)) {
    const name = d[1] ?? d[2];
    const isFunctionKeyword = d[1] !== undefined || d[3] === "function";
    const from = d.index! + d[0].length;
    const body = findBody(m, from, !isFunctionKeyword);
    if (body) scopes.push({ name, ...body });
  }
  return scopes;
}

/** Text of the first call argument, given the index just after `writeFile(`. */
function firstArgument(src: string, m: string, from: number): string {
  let depth = 0;
  for (let k = from; k < m.length; k++) {
    const c = m[k];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return normalise(src.slice(from, k));
      depth--;
    } else if (c === "," && depth === 0) return normalise(src.slice(from, k));
  }
  return normalise(src.slice(from));
}

const normalise = (s: string): string => s.trim().replace(/\s+/g, " ");

export function scanWriteSites(source: string, file: string): WriteSite[] {
  const m = mask(source);
  const scopes = findScopes(m);
  const sites: WriteSite[] = [];
  for (const call of m.matchAll(/\bwriteFile\s*\(/g)) {
    const at = call.index!;
    // A declaration named writeFile is not a call.
    if (/\bfunction\s*\*?\s+$/.test(m.slice(Math.max(0, at - 24), at)))
      continue;
    const enclosing = scopes
      .filter((s) => s.start <= at && at < s.end)
      .sort((a, b) => b.start - a.start)[0];
    const fn = enclosing?.name ?? "(top-level)";
    const destExpr = firstArgument(source, m, at + call[0].length);
    sites.push({
      file,
      fn,
      destExpr,
      line: source.slice(0, at).split("\n").length,
      site: `${file}#${fn}`,
      key: `${file}#${fn}#${destExpr}`,
    });
  }
  return sites;
}

/**
 * @param registry `file#fn#destExpr` → the destination that write lands on
 * @param declared destinations declared in NON_TEMPLATE_DESTINATIONS
 * @param routedPrefixes destination prefixes covered by a `templates/` route
 *   (side a) — a registry destination under one needs no separate declaration
 */
export function checkWriteSites(
  sites: WriteSite[],
  registry: Record<string, string>,
  declared: Iterable<string>,
  routedPrefixes: string[],
): WriteSiteCheck {
  const declaredSet = new Set(declared);
  const undeclaredSites = sites.filter((s) => !(s.key in registry));
  const undeclaredDestinations: WriteSiteCheck["undeclaredDestinations"] = [];
  for (const key of new Set(sites.map((s) => s.key))) {
    const destination = registry[key];
    if (destination === undefined || declaredSet.has(destination)) continue;
    if (routedPrefixes.some((p) => destination.startsWith(p))) continue;
    undeclaredDestinations.push({ key, destination });
  }
  return { undeclaredSites, undeclaredDestinations };
}

export function formatWriteSiteFailures(check: WriteSiteCheck): string {
  const parts: string[] = [];
  if (check.undeclaredSites.length > 0) {
    parts.push(
      `unregistered writeFile site(s) — declare the destination's ownership policy, then register the site: ${check.undeclaredSites
        .map((s) => `${s.site} writes ${s.destExpr} (line ${s.line})`)
        .join(", ")}`,
    );
  }
  if (check.undeclaredDestinations.length > 0) {
    parts.push(
      `destination(s) not in NON_TEMPLATE_DESTINATIONS: ${check.undeclaredDestinations
        .map((d) => `${d.key} → ${d.destination}`)
        .join(", ")}`,
    );
  }
  return parts.join("; ");
}
