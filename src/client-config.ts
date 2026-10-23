import * as path from "path";
import { defaultTokenFile } from "./token-store";

/**
 * Output exactly what the user (or their MCP client) needs to paste into
 * their MCP config — the same stanzas the /docs page teaches. Stanzas use
 * the `npx -y @elsm/mcp` form so they work right after `npm publish`; the
 * --token-file flag is only included when it differs from the default path.
 */

export interface ClientStanza {
  header: string;
  lang: string;
  code: string;
}

export function clientConfigStanzas(port: number, tokenFile: string): ClientStanza[] {
  const isDefaultToken = tokenFile === defaultTokenFile();
  const tokenArgs = isDefaultToken ? [] : ["--token-file", tokenFile];
  const npxArgs = ["-y", "@elsm/mcp", "--port", String(port), ...tokenArgs];
  const jsonStanza = { command: "npx", args: npxArgs };
  const tokenNote = isDefaultToken
    ? ""
    : `\n# custom token file: ${tokenFile}`;

  return [
    {
      header:
        "Generic mcpServers JSON — Cursor (.cursor/mcp.json), Claude Desktop (claude_desktop_config.json), Gemini CLI (~/.gemini/settings.json)",
      lang: "json",
      code:
        JSON.stringify({ mcpServers: { elsm: jsonStanza } }, null, 2) + tokenNote
    },
    {
      header: "Claude Code — run from your project root",
      lang: "bash",
      code: `claude mcp add elsm -- npx -y @elsm/mcp --port ${port}${tokenArgs.length ? " " + tokenArgs.join(" ") : ""}${tokenNote}`
    },
    {
      header: "Codex CLI (~/.codex/config.toml)",
      lang: "toml",
      code: `[mcp_servers.elsm]\ncommand = "npx"\nargs = ${JSON.stringify(npxArgs)}${tokenNote}`
    },
    {
      header: "OpenCode (~/.config/opencode/opencode.json)",
      lang: "json",
      code:
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              elsm: {
                type: "local",
                command: ["npx", ...npxArgs],
                enabled: true
              }
            }
          },
          null,
          2
        ) + tokenNote
    }
  ];
}

export function printClientConfig(port: number, tokenFile: string): void {
  const lines: string[] = [];
  lines.push(`# elsm-mcp client config for ws://127.0.0.1:${port}`);
  lines.push(`# token file: ${tokenFile}`);
  lines.push("");
  for (const stanza of clientConfigStanzas(port, tokenFile)) {
    lines.push(`### ${stanza.header}`);
    lines.push("```" + stanza.lang);
    lines.push(stanza.code);
    lines.push("```");
    lines.push("");
  }
  lines.push(
    "# The bridge reads the token file itself; your agent config never needs the token value."
  );
  process.stderr.write(lines.join("\n") + "\n");
}

export const absolutizeTokenFile = (file: string): string =>
  path.isAbsolute(file) ? file : path.resolve(file);
