import { query } from "@anthropic-ai/claude-agent-sdk";
const variants = {
  baseline: {},
  strictMcpConfig: { strictMcpConfig: true },
  disableClaudeAiConnectors: { settings: { disableClaudeAiConnectors: true } },
  both: { strictMcpConfig: true, settings: { disableClaudeAiConnectors: true } },
};
for (const [name, extra] of Object.entries(variants)) {
  const ac = new AbortController();
  const q = query({ prompt: "reply ok", options: { abortController: ac, cwd: process.argv[2], settingSources: ["project"],
    permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    mcpServers: { probe: { type: "stdio", command: "node", args: ["-e", "setInterval(()=>{},1e6)"] } }, ...extra } });
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        console.log(`== ${name} (cc ${m.claude_code_version})`);
        for (const s of m.mcp_servers) console.log(`   ${s.name.padEnd(28)} ${s.status.padEnd(11)} source=${s.source ?? s.scope ?? "?"}`);
        ac.abort(); break;
      }
    }
  } catch (e) { if (!String(e).includes("abort")) console.log(`   err: ${e}`); }
}
