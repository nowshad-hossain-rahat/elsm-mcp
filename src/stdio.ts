import * as readline from "readline";

/**
 * stdio transport for MCP. Deliberately no MCP SDK: the JSON-RPC surface an
 * MCP server needs is tiny and the bridge must stay protocol-only with no
 * client-specific code. Accepts both framings that real clients emit —
 * newline-delimited JSON (default in the current spec's stdio transport) and
 * LSP-style Content-Length headers (older tooling).
 */
export class StdioTransport {
  private handlers = new Map<string, (params: unknown) => Promise<unknown>>();

  constructor(
    private readonly write: (frame: string) => void,
    private readonly onClientClosed: () => void
  ) {}

  /** Register a request handler for an MCP method, e.g. "tools/call". */
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.handlers.set(method, handler);
  }

  /** Fire a JSON-RPC notification at the client (e.g. tools/list_changed). */
  notify(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.writeFrame({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" }
        });
        return;
      }
      void this.dispatch(msg);
    };

    // LSP-style header state — engages only if a Content-Length line shows up.
    let headerMode = false;
    let bodyLength = 0;
    let body = "";

    rl.on("line", (line) => {
      if (!headerMode) {
        const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
        if (match) {
          headerMode = true;
          bodyLength = parseInt(match[1] ?? "0", 10);
          body = "";
          return;
        }
        processLine(line);
        return;
      }
      // Header mode: a blank line separates headers from the body; everything
      // after is accumulated until `bodyLength` bytes have arrived.
      if (bodyLength === 0 && !body) {
        if (line.trim()) {
          const m = /^content-length:\s*(\d+)\s*$/i.exec(line);
          if (m) bodyLength = parseInt(m[1] ?? "0", 10);
        }
        return;
      }
      body += line;
      if (bodyLength > 0 && body.length >= bodyLength) {
        const chunk = body.slice(0, bodyLength);
        body = body.slice(bodyLength);
        bodyLength = 0;
        processLine(chunk);
      }
    });

    rl.on("close", () => this.onClientClosed());
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    if (msg.id === undefined || msg.id === null) {
      // A notification from the client (initialized/cancelled/esco…): nothing
      // needs answering. Unrouted ones are silently dropped at this layer.
      return;
    }
    if (typeof msg.method !== "string") {
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32600, message: "Invalid request: missing method" }
      });
      return;
    }
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      });
      return;
    }
    try {
      const result = await handler(msg.params);
      this.writeFrame({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: typeof e?.code === "number" ? e.code : -32603,
          message: e?.message ?? "Internal error"
        }
      });
    }
  }

  private writeFrame(payload: unknown): void {
    this.write(JSON.stringify(payload));
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
