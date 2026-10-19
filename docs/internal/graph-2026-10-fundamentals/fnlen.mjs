// Phase-0 measurement script for graph-2026-10-fundamentals (re-created 2026-10-18 after the
// scratchpad was cleaned). Run from the sequant repo root:  node <path>/fnlen.mjs
// Prints: function-length distribution (raw AST span), catch-clause counts, import cycles
// (type-only imports excluded), and upward imports. F-01 turns these definitions into
// scripts/qa/health-report.ts; the ratchet uses ESLint's max-lines-per-function counting.
// `typescript` resolves from this file's directory upward, so the script must live inside the repo
// (docs/internal/graph-2026-10-fundamentals/) or be run with NODE_PATH pointing at the repo's node_modules.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
  }
})("src");
for (const e of fs.readdirSync("bin", { withFileTypes: true })) if (/\.ts$/.test(e.name)) files.push(path.join("bin", e.name));

const fns = []; const graph = new Map();
let catches = 0, emptyCatches = 0; const catchByFile = {};
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const deps = new Set();
  (function visit(n) {
    if (ts.isCatchClause(n)) { catches++; if (n.block.statements.length === 0) { emptyCatches++; catchByFile[f] = (catchByFile[f] || 0) + 1; } }
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body) {
      const a = sf.getLineAndCharacterOfPosition(n.getStart()).line, b = sf.getLineAndCharacterOfPosition(n.end).line;
      const name = n.name?.getText?.() || (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText() : "<anon>");
      fns.push({ f, name, len: b - a + 1, line: a + 1 });
    }
    if ((ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) || (ts.isExportDeclaration(n) && !n.isTypeOnly)) {
      const m = n.moduleSpecifier?.text;
      if (m && m.startsWith(".")) {
        const r = path.resolve(path.dirname(f), m).replace(/\.js$/, "");
        for (const c of [r + ".ts", r + ".tsx", r + "/index.ts"]) if (fs.existsSync(c)) { deps.add(path.relative(".", c)); break; }
      }
    }
    ts.forEachChild(n, visit);
  })(sf);
  graph.set(path.relative(".", f), deps);
}
console.log("catch clauses", catches, "| empty-body catch clauses", emptyCatches);
console.log(Object.entries(catchByFile).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => v + " " + k).join("\n"));
fns.sort((a, b) => b.len - a.len);
console.log("functions total", fns.length, "| >100 lines:", fns.filter(x => x.len > 100).length, "| >200:", fns.filter(x => x.len > 200).length, "| >400:", fns.filter(x => x.len > 400).length);
for (const x of fns.slice(0, 10)) console.log(String(x.len).padStart(5), x.f + ":" + x.line, x.name);

// Tarjan SCC over runtime imports
let idx = 0; const st = [], on = new Set(), low = new Map(), num = new Map(), sccs = [];
function sc(v) {
  num.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
  for (const w of graph.get(v) || []) {
    if (!num.has(w)) { sc(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (on.has(w)) low.set(v, Math.min(low.get(v), num.get(w)));
  }
  if (low.get(v) === num.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); }
}
for (const v of graph.keys()) if (!num.has(v)) sc(v);
console.log("modules", graph.size, "| cyclic SCCs", sccs.length, "| modules in cycles", sccs.reduce((a, c) => a + c.length, 0));
for (const c of sccs.sort((a, b) => b.length - a.length).slice(0, 5)) console.log(" cycle(" + c.length + "):", c.join(", "));
const viol = [];
for (const [f, d] of graph) for (const w of d) {
  if (f.startsWith("src/lib/") && (w.startsWith("src/commands/") || w.startsWith("bin/"))) viol.push(f + " -> " + w);
  if (f.startsWith("src/mcp/") && w.startsWith("src/commands/")) viol.push(f + " -> " + w);
}
console.log("upward imports (lib->commands/bin, mcp->commands):", viol.length); for (const v of viol) console.log(" ", v);
