// Phase-0 probes for the claude-cloud driver (#1151, gating #1137).
//
// Each subcommand prints one JSON object. Credentials come from the
// environment only and are never printed:
//   CLAUDE_CODE_OAUTH_TOKEN   token from `claude setup-token`
//   SEQUANT_PROBE_ORG_UUID    claude.ai organization UUID (x-organization-uuid)
//
// Headers mirror what the Claude Code CLI (2.1.282) sends to the same
// endpoints: bearer token, `anthropic-version`, the `ccr-byoc-2025-07-29`
// beta and `x-organization-uuid`.
//
// Usage: npx tsx scripts/probes/claude-cloud-probe.ts auth

const BASE_URL =
  process.env.SEQUANT_PROBE_BASE_URL ?? "https://api.anthropic.com";

interface ProbeResponse {
  endpoint: string;
  status: number;
  /** Response body with anything credential-shaped redacted. */
  body: unknown;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.log(JSON.stringify({ error: `${name} is not set` }));
    process.exit(2);
  }
  return value;
}

/** Redact tokens, UUIDs and emails from any string before it is printed. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "<redacted-token>")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>");
}

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ProbeResponse> {
  const token = requireEnv("CLAUDE_CODE_OAUTH_TOKEN");
  const org = requireEnv("SEQUANT_PROBE_ORG_UUID");
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "ccr-byoc-2025-07-29",
      "x-organization-uuid": org,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = redact(await res.text(), [token, org]);
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the raw (redacted) text
  }
  return { endpoint: `${method} ${path}`, status: res.status, body: parsed };
}

/** Summarize a list response to names/ids/kinds so output stays small. */
function summarize(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const obj = body as Record<string, unknown>;
  const list = (obj.environments ?? obj.data ?? obj.triggers) as unknown;
  if (!Array.isArray(list)) return body;
  return {
    count: list.length,
    items: list.map((e: Record<string, unknown>) => ({
      id: e.environment_id ?? e.id,
      name: e.name,
      kind: e.kind,
    })),
  };
}

async function auth(): Promise<void> {
  const results = [];
  for (const path of ["/v1/environment_providers", "/v1/code/triggers"]) {
    const r = await call("GET", path);
    results.push({ ...r, body: r.status === 200 ? summarize(r.body) : r.body });
  }
  const pass = results.every((r) => r.status === 200);
  console.log(
    JSON.stringify(
      { probe: "P-1", verdict: pass ? "pass" : "fail", results },
      null,
      2,
    ),
  );
}

const commands: Record<string, () => Promise<void>> = { auth };

const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.log(
    JSON.stringify({
      error: `usage: claude-cloud-probe.ts <${Object.keys(commands).join("|")}>`,
    }),
  );
  process.exit(2);
}
await commands[cmd]();
