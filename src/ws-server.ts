import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type * as http from "http";
import { BRIDGE_PROTOCOL_VERSION, REQUEST_TIMEOUT_MS, WS_MAX_PAYLOAD_BYTES } from "./config";
import { tokenMatches } from "./pairing";
import type {
  AgentIdentity,
  BridgeAction,
  BridgeClientMessage,
  BridgeEventMessage,
  BridgeServerMessage
} from "./types";

export interface ExtensionSessionInfo {
  extensionName: string;
  extensionVersion: string;
  protocolVersion: number;
  remoteAddress: string;
  connectedAt: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: { code: string; message: string }) => void;
  timer: NodeJS.Timeout;
}

export interface WsBridgeEvents {
  onSessionStart: (info: ExtensionSessionInfo) => void;
  onSessionEnd: (reason: string) => void;
  onReject: (reason: string, detail: string) => void;
  onEvent: (event: BridgeEventMessage) => void;
}

/**
 * Loopback WebSocket server.
 *
 * Security model (tied to the product's zero-knowledge promise):
 * - the server binds a loopback address only — never a routable interface;
 * - the first frame MUST be a valid `hello` carrying the pairing token. Any
 *   other frame from a not-yet-authenticated socket is dropped, and the
 *   handshake timeout closes hello-less sockets;
 * - `response` frames are only accepted from the currently authenticated
 *   socket, so another local process (or the pre-auth phase of one) cannot
 *   inject forged tool results;
 * - protocol version mismatch is a hard refusal, never a downgrade: a newer
 *   Chrome auto-update must fail loudly instead of silently misbehaving.
 */
export class ExtensionSocketServer {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private session: ExtensionSessionInfo | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextRequestId = 0;
  private agentInfo: AgentIdentity | null = null;

  constructor(
    private readonly token: string,
    private readonly bridgeVersion: string,
    private readonly events: WsBridgeEvents
  ) {}

  get isPaired(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  get sessionInfo(): ExtensionSessionInfo | null {
    return this.session;
  }

  /** MCP client identity, captured from the stdio initialize handshake. */
  setAgentInfo(info: AgentIdentity): void {
    this.agentInfo = {
      name: String(info?.name || "unknown-agent"),
      version: String(info?.version || "0")
    };
  }

  start(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port, maxPayload: WS_MAX_PAYLOAD_BYTES });
      this.wss = wss;
      wss.on("error", reject);
      wss.on("listening", () => {
        const address = wss.address();
        const realPort = typeof address === "object" && address !== null && "port" in address
          ? address.port
          : port;
        resolve(realPort);
      });
      wss.on("connection", (socket, req) => this.onConnection(socket, req));
    });
  }

  stop(): void {
    this.failPending("bridge-shutdown", "The bridge is shutting down");
    this.wss?.close();
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.wss = null;
  }

  request<T = unknown>(
    action: BridgeAction,
    params: Record<string, unknown>
  ): Promise<T> {
    if (!this.isPaired || !this.socket) {
      return Promise.reject({
        code: "not-connected",
        message:
          "The ELSM browser extension is not connected. Open the sidebar → Agent access panel and pair this machine, then retry."
      });
    }
    const socket = this.socket;
    const id = `r${++this.nextRequestId}-${crypto.randomBytes(4).toString("hex")}`;
    const frame: BridgeServerMessage = {
      type: "request",
      id,
      action,
      params,
      agent: this.agentInfo ?? undefined
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({
          code: "timeout",
          message: `Extension did not answer "${action}" within ${REQUEST_TIMEOUT_MS}ms`
        });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      });
      socket.send(JSON.stringify(frame));
    });
  }

  private failPending(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject({ code, message });
      this.pending.delete(id);
    }
  }

  private onConnection(socket: WebSocket, req: http.IncomingMessage): void {
    let authenticated = false;
    const handshakeTimeout = setTimeout(() => {
      if (this.socket !== socket) socket.close(4000, "hello timeout");
    }, 10_000);

    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      // Only the current session owns the pending map; a replaced socket's
      // pendings were already failed by the replacement branch below.
      if (this.socket === socket) {
        this.socket = null;
        this.session = null;
        this.failPending("extension-disconnected", "The extension closed the connection");
        this.events.onSessionEnd(req.socket.remoteAddress || "unknown");
      }
    });

    socket.on("error", () => {
      /* close handler does clean-up */
    });

    socket.on("message", (data) => {
      let msg: BridgeClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        socket.close(4002, "bad frame");
        return;
      }

      // Until this socket has completed the token handshake, nothing but a
      // `hello` is accepted — drop everything else (it cannot be trusted).
      if (!authenticated) {
        if (msg?.type !== "hello") return;
      }

      if (msg?.type === "hello") {
        clearTimeout(handshakeTimeout);
        if (!tokenMatches(msg.token || "", this.token)) {
          socket.send(JSON.stringify({
            type: "hello-error",
            code: "bad-token",
            message: "Pairing token mismatch — rejected before framing anything else"
          }));
          this.events.onReject("bad-token", req.socket.remoteAddress || "?");
          socket.close(4001, "bad token");
          return;
        }
        if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          socket.send(JSON.stringify({
            type: "hello-error",
            code: "unsupported-version",
            message: `Protocol version mismatch: extension speaks v${msg.protocolVersion}, bridge speaks v${BRIDGE_PROTOCOL_VERSION}`
          }));
          this.events.onReject("unsupported-version", `${msg.extVersion} v${msg.protocolVersion}`);
          socket.close(4003, "unsupported protocol version");
          return;
        }
        // Last-writer-wins: a second (valid) connection replaces the current
        // session honestly rather than dangling both. Fail the old session's
        // in-flight requests BEFORE re-pointing state, so its close handler
        // does not skip them.
        if (this.socket && this.socket !== socket) {
          const previous = this.socket;
          this.failPending("session-replaced", "A newer extension connection replaced this session");
          this.session = null;
          previous.close(4009, "replaced by a newer connection");
        }
        authenticated = true;
        this.socket = socket;
        this.nextRequestId = 0;
        this.session = {
          extensionName: msg.extensionName || "unknown",
          extensionVersion: msg.extVersion || "unknown",
          protocolVersion: msg.protocolVersion,
          remoteAddress: req.socket.remoteAddress || "127.0.0.1",
          connectedAt: Date.now()
        };
        socket.send(JSON.stringify({
          type: "hello-ack",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          bridgeVersion: this.bridgeVersion
        }));
        this.events.onSessionStart(this.session);
        return;
      }

      if (msg?.type === "response") {
        // Forged-result protection: only the authenticated session's socket
        // may answer requests.
        if (socket !== this.socket || !this.pending.has(msg.id)) return;
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(msg.error ?? { code: "unknown", message: "Unknown extension error" });
        return;
      }

      if (msg?.type === "event") {
        this.events.onEvent(msg);
        return;
      }
    });
  }
}
