import * as readline from "readline";

/** Context handed to request handlers alongside the params. */
export interface HandlerContext {
  /** Aborted when the client sends `notifications/cancelled` for this request id. */
  signal: AbortSignal;
}

/**
 * stdio transport for MCP. Deliberately no MCP SDK: the JSON-RPC surface an
 * MCP server needs is tiny and the bridge must stay protocol-only with no
 * client-specific code. Accepts both framings that real clients emit —
 * newline-delimited JSON (default in the current spec's stdio transport) and
 * LSP-style Content-Length headers (older tooling).
 */
export class StdioTransport {
  private handlers = new Map<
    string,
    (params: unknown, ctx: HandlerContext) => Promise<unknown>
  >();
  private inFlight = new Map<string | number, AbortController>();

  constructor(
    private readonly write: (frame: string) => void,
    private readonly onClientClosed: () => void
  ) {}

  /** Register a request handler for an MCP method, e.g. "tools/call". */
  onRequest(
    method: string,
    handler: (params: unknown, ctx: HandlerContext) => Promise<unknown>
  ): void {
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
    // Content-Length counts BYTES; readline hands us decoded strings, so the
    // body is measured with Buffer.byteLength (UTF-16 .length undercounts
    // multi-byte characters and the frame would never complete).
    let headerMode = false;
    let bodyLength = 0;
    let body = "";
    let bodyBytes = 0;

    rl.on("line", (line) => {
      if (!headerMode) {
        const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
        if (match) {
          headerMode = true;
          bodyLength = parseInt(match[1] ?? "0", 10);
          body = "";
          bodyBytes = 0;
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
      body += body ? `\n${line}` : line;
      // +1: the newline readline consumed after this line.
      bodyBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bodyLength > 0 && bodyBytes >= bodyLength) {
        // One message per framed body (what every LSP-framing client sends).
        const chunk = body;
        headerMode = false;
        body = "";
        bodyBytes = 0;
        bodyLength = 0;
        processLine(chunk);
      }
    });

    rl.on("close", () => this.onClientClosed());
  }

  private async dispatch(msg: JsonRpcMessage): Promise<void> {
    if (msg.id === undefined || msg.id === null) {
      // A notification from the client. Cancellation is the one we must act
      // on: abort the in-flight handler so a cancelled tool call stops
      // waiting (and its late result is dropped, not written for a dead id).
      if (msg.method === "notifications/cancelled") {
        const p = (msg.params ?? {}) as { requestId?: string | number };
        this.inFlight.get(p.requestId as string | number)?.abort();
      }
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
    const controller = new AbortController();
    this.inFlight.set(msg.id, controller);
    try {
      const result = await handler(msg.params, { signal: controller.signal });
      this.writeFrame({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      // A cancelled call gets no error frame: JSON-RPC cancellation means the
      // client has stopped listening for that id.
      if (controller.signal.aborted) return;
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: typeof e?.code === "number" ? e.code : -32603,
          message: e?.message ?? "Internal error"
        }
      });
    } finally {
      this.inFlight.delete(msg.id);
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
