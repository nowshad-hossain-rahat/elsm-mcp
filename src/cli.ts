#!/usr/bin/env node
/**
 * elsm-mcp — MCP server bridge for the ELSM browser extension.
 *
 * stdio (MCP) ⇄ this process ⇄ ws://127.0.0.1:<port> ⇄ extension offscreen doc.
 * Intended to be launched by the user's MCP client. Pairing works the other
 * way: the extension holds the token, the user confirms it once per machine.
 */
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION, DEFAULT_HOST, DEFAULT_PORT, MCP_LATEST_PROTOCOL_VERSION, TOKEN_FILE_ENV } from "./config";
import { ExtensionSocketServer } from "./ws-server";
import { McpServer } from "./mcp-server";
import { parseToolCall } from "./tools";
import { StdioTransport } from "./stdio";
import { printClientConfig } from "./client-config";
import { defaultTokenFile, loadOrCreateToken } from "./token-store";

type ParsedArgs = {
  port?: number;
  tokenFile?: string;
  printConfig?: boolean;
  selftest?: boolean;
  help?: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--print-config") out.printConfig = true;
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--port") {
      const v = argv[i + 1];
      if (v) out.port = parseInt(v, 10);
      i++;
    } else if (a === "--token-file") {
      const v = argv[i + 1];
      if (v) out.tokenFile = v;
      i++;
    } else if (a.startsWith("--")) {
      /* unknown flag — ignore, don't crash the client */
    }
  }
  return out;
}

function log(line: string): void {
  // stderr only — stdout is the MCP wire.
  process.stderr.write(`[elsm-mcp] ${line}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stderr.write(
      "elsm-mcp — MCP bridge for the ELSM extension\n\n" +
      "  --port <n>        fixed WS port (default: " + DEFAULT_PORT + ")\n" +
      "  --token-file <f>  pairing token file (default: " + defaultTokenFile() + ")\n" +
      "  --print-config    print the mcpServers stanzas for common clients and exit\n" +
      "  --selftest        run the internal smoke test and exit\n"
    );
    return;
  }

  const tokenFile = args.tokenFile ?? process.env[TOKEN_FILE_ENV] ?? defaultTokenFile();

  if (args.printConfig) {
    printClientConfig(args.port ?? DEFAULT_PORT, tokenFile);
    return;
  }

  const { token, created } = loadOrCreateToken(tokenFile);
  if (created) {
    log(`Wrote a new pairing token to ${tokenFile}`);
    log("The extension will ask you to confirm this token in a dialog once per browser.");
  }

  const extensionSocket = new ExtensionSocketServer(token, BRIDGE_VERSION, {
    onSessionStart: (info) =>
      log(`Extension paired: ${info.extensionName} v${info.extensionVersion} (protocol v${info.protocolVersion})`),
    onSessionEnd: (reason) => log(`Extension disconnected: ${reason}`),
    onReject: (reason, detail) => log(`Refused connection: ${reason} (${detail})`),
    onEvent: (event) => {
      // Mutating-storage events are surfaced as logs for now; Phase 2 uses
      // them to build snapshots.
      log(`event ${event.event}: ${JSON.stringify(event.payload)}`);
    }
  });

  const port = await extensionSocket.start(args.port ?? DEFAULT_PORT, DEFAULT_HOST);
  log(`listening on ws://${DEFAULT_HOST}:${port} (bridge protocol v${BRIDGE_PROTOCOL_VERSION}, MCP ${MCP_LATEST_PROTOCOL_VERSION}+, token ${tokenFile})`);

  const mcp = new McpServer(extensionSocket);
  const transport = new StdioTransport(
    (frame) => {
      process.stdout.write(frame + "\n");
    },
    () => {
      extensionSocket.stop();
      process.exit(0);
    }
  );

  transport.onRequest("initialize", (params) => Promise.resolve(mcp.initialize(params)));
  transport.onRequest("ping", () => Promise.resolve({}));
  transport.onRequest("tools/list", () => Promise.resolve(mcp.toolsList()));
  transport.onRequest("tools/call", async (params: unknown) => {
    const call = parseToolCall(params);
    return mcp.toolsCall(call);
  });

  transport.start();
  log("stdio ready; waiting for the extension to pair (or for MCP traffic)");
}

if (process.argv.includes("--selftest")) {
  // Selftest never spins up the real server; run the checks and exit.
  void import("./selftest")
    .then((m) => m.runSelftest())
    .catch((err: unknown) => {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else {
  main().catch((err: unknown) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
