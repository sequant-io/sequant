// #856 AC-3: does MCP shutdown cause the post-turn hang?
//
// Flips exactly the variable sequant's `--no-mcp` flips — the Agent SDK's
// `mcpServers` option (drivers/claude-code.ts:118) — holding everything else
// constant, and measures each nested session's TurnEnd -> SessionEnd gap
// against the 0.36s healthy baseline.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";
import { execSync } from "child_process";

const LOG = "/Users/tony/Projects/sequant/.entire/logs/entire.log";
const REPS = Number(process.env.REPS ?? 3);

// Must match sequant's own resolver (system.ts getClaudeConfigPath →
// getMcpServersConfig), NOT ~/.claude.json — reading the wrong path silently
// yields zero servers and turns the "MCP ON" arm into a second control.
function mcpServers() {
  const p =
    process.env.HOME +
    "/Library/Application Support/Claude/claude_desktop_config.json";
  // Deliberately NOT swallowing errors: a silent catch here reads as "no MCP
  // configured" and turns the treatment arm into a second control, which is
  // exactly how the first two runs of this experiment produced a null result.
  const c = JSON.parse(readFileSync(p, "utf8"));
  const s = c.mcpServers;
  if (!s || typeof s !== "object" || Object.keys(s).length === 0) {
    throw new Error(`no mcpServers in ${p} — treatment arm would be a control`);
  }
  return s;
}

async function runOnce(withMcp, servers) {
  const t0 = Date.now();
  let sessionId = null;
  const q = query({
    prompt: "Reply with exactly: ok",
    options: {
      cwd: "/Users/tony/Projects/sequant",
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(withMcp && servers ? { mcpServers: servers } : {}),
    },
  });
  for await (const m of q) {
    if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
  }
  return { sessionId, wallSec: (Date.now() - t0) / 1000 };
}

// Parse TurnEnd -> SessionEnd for a specific session id.
function gapFor(sessionId) {
  const RE = /"session_id":"([^"]+)"/g;
  let lastTurn = null;
  for (const line of readFileSync(LOG, "utf-8").split("\n")) {
    if (!line.startsWith("{")) continue;
    if (!line.includes(sessionId)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = Date.parse(e.time);
    if (!Number.isFinite(t)) continue;
    if (e.event === "TurnEnd") lastTurn = t;
    else if (e.event === "SessionEnd" && lastTurn !== null)
      return (t - lastTurn) / 1000;
  }
  return null;
}

const servers = mcpServers();
console.log(
  `MCP servers available: ${servers ? Object.keys(servers).length : 0}` +
    (servers ? ` (${Object.keys(servers).join(", ")})` : ""),
);

const results = { mcp: [], noMcp: [] };
for (let i = 0; i < REPS; i++) {
  for (const withMcp of [true, false]) {
    const r = await runOnce(withMcp, servers);
    results[withMcp ? "mcp" : "noMcp"].push(r);
    console.log(
      `  rep${i + 1} mcp=${withMcp ? "on " : "off"} wall=${r.wallSec.toFixed(1)}s session=${r.sessionId}`,
    );
  }
}

// Give entire's SessionEnd hook a moment to land in the log.
await new Promise((r) => setTimeout(r, 8000));

console.log("\n=== TurnEnd -> SessionEnd gap (baseline: 0.36s healthy) ===");
for (const key of ["mcp", "noMcp"]) {
  const gaps = results[key]
    .map((r) => (r.sessionId ? gapFor(r.sessionId) : null))
    .filter((g) => g !== null);
  const label = key === "mcp" ? "MCP ON " : "MCP OFF";
  if (!gaps.length) {
    console.log(`${label}: no gap recorded`);
    continue;
  }
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  console.log(
    `${label}: ${gaps.map((g) => g.toFixed(2) + "s").join(", ")}  (mean ${avg.toFixed(2)}s)`,
  );
}
console.log("\nwall-clock means:");
for (const key of ["mcp", "noMcp"]) {
  const w = results[key].map((r) => r.wallSec);
  console.log(
    `  ${key === "mcp" ? "MCP ON " : "MCP OFF"}: mean ${(w.reduce((a, b) => a + b, 0) / w.length).toFixed(1)}s`,
  );
}
