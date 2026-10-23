import { BRIDGE_VERSION, MCP_LATEST_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from "./config";
import { TOOL_DEFS, parseToolCall, validateToolArgs } from "./tools";
import type { BridgeAction } from "./types";
import type { ExtensionSocketServer } from "./ws-server";

/**
 * Minimal protocol-only MCP server implementation. The negotiated MCP
 * protocol-version precedence list lives in config.ts (MCP_PROTOCOL_VERSIONS,
 * newest first); the client's version is honoured when supported.
 */

export const BRIDGE_TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

export class McpServer {
  constructor(private readonly extensionSocket: ExtensionSocketServer) {}

  toolsList() {
    return {
      tools: TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    };
  }

  async toolsCall(call: { name: string; args: unknown }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const def = TOOL_DEFS.find((t) => t.name === call.name);
    if (!def) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${call.name}` }],
        isError: true
      };
    }
    const args = (call.args ?? {}) as Record<string, unknown>;
    try {
      validateToolArgs(def, args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Invalid args: ${message}` }],
        isError: true
      };
    }

    try {
      const result = await this.extensionSocket.request<BridgeAction>(
        def.action,
        args
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (err: unknown) {
      const nested = (err ?? {}) as { message?: string };
      const message = nested.message ?? String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true
      };
    }
  }

  initialize(params: unknown): Record<string, unknown> {
    const p = (params ?? {}) as {
      protocolVersion?: string;
      clientInfo?: { name?: string; version?: string };
    };
    const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
    const negotiated = MCP_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : MCP_LATEST_PROTOCOL_VERSION;
    // Attribute subsequent tool calls to this agent (flows to the extension
    // on every request frame so the sidebar can show/manage connected agents).
    this.extensionSocket.setAgentInfo({
      name: typeof p.clientInfo?.name === "string" ? p.clientInfo.name : "unknown-agent",
      version: typeof p.clientInfo?.version === "string" ? p.clientInfo.version : "0"
    });
    return {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: {
        name: "elsm-mcp",
        title: "Easy Local Storage Manager bridge",
        version: BRIDGE_VERSION
      }
    };
  }
}
