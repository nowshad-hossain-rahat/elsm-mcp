import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type * as http from "http";
import {
  BRIDGE_PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  MAX_BAD_FRAMES_PER_CONNECTION,
  REQUEST_TIMEOUT_MS,
  SEND_BUFFER_CAP_BYTES,
  WS_MAX_PAYLOAD_BYTES
} from "./config";
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
  abort?: AbortSignal;
  onAbort?: () => void;
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
 * - `hello` fields are type-checked BEFORE any crypto touches them: a frame
 *   like `{"token":{}}` must answer with a refusal, never reach the hasher
 *   and take the process down;
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
  private heartbeat: NodeJS.Timeout | null = null;
  private socketAlive = false;

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
    this.stopHeartbeat();
    this.failPending("bridge-shutdown", "The bridge is shutting down");
    this.wss?.close();
    this.socket?.close();
    this.socket = null;
    this.session = null;
    this.wss = null;
  }

  request<T = unknown>(
    action: BridgeAction,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.isPaired || !this.socket) {
      return Promise.reject({
        code: "not-connected",
        message:
          "The ELSM browser extension is not connected. Open the sidebar → Agent access panel and pair this machine, then retry."
      });
    }
    if (signal?.aborted) {
      return Promise.reject({ code: "cancelled", message: "The agent cancelled this call" });
    }
    const socket = this.socket;
    // Backpressure: a stalled extension stops draining its TCP buffer. Past
    // the cap, further sends only trade bounded memory for latency — fail
    // fast and let the agent retry when the pipe recovers.
    if (socket.bufferedAmount > SEND_BUFFER_CAP_BYTES) {
      return Promise.reject({
        code: "overloaded",
        message: "The extension connection is not draining; retry shortly"
      });
    }
    const id = `r${++this.nextRequestId}-${crypto.randomBytes(4).toString("hex")}`;
    const frame: BridgeServerMessage = {
      type: "request",
      id,
      action,
      params,
      agent: this.agentInfo ?? undefined
    };
    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject({
            code: "timeout",
            message: `Extension did not answer "${action}" within ${REQUEST_TIMEOUT_MS}ms`
          })
        );
      }, REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        settle(() => reject({ code: "cancelled", message: "The agent cancelled this call" }));
      };
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        abort: signal,
        onAbort
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.send(JSON.stringify(frame));
    });
  }

  private failPending(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.abort?.removeEventListener("abort", p.onAbort!);
      p.reject({ code, message });
      this.pending.delete(id);
    }
  }

  // ===== Liveness =====

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.socketAlive = true;
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeat();
        return;
      }
      if (!this.socketAlive) {
        // No pong since the last ping: half-open pipe (e.g. machine slept).
        // terminate() is immediate — close() would wait for a TCP farewell
        // the dead peer will never send.
        socket.terminate();
        return;
      }
      this.socketAlive = false;
      socket.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private onConnection(socket: WebSocket, req: http.IncomingMessage): void {
    let authenticated = false;
    let badFrames = 0;
    const handshakeTimeout = setTimeout(() => {
      if (this.socket !== socket) socket.close(4000, "hello timeout");
    }, 10_000);

    socket.on("pong", () => {
      this.socketAlive = true;
    });

    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      if (this.socket === socket) this.stopHeartbeat();
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
        // A truncated frame must not kill a healthy session, but endless
        // garbage means the peer is broken — cap and close.
        badFrames += 1;
        if (badFrames >= MAX_BAD_FRAMES_PER_CONNECTION) {
          socket.close(4002, "too many malformed frames");
        } else {
          process.stderr.write(
            `[elsm-mcp] ignoring malformed frame ${badFrames}/${MAX_BAD_FRAMES_PER_CONNECTION} from ${req.socket.remoteAddress || "?"}\n`
          );
        }
        return;
      }

      // Until this socket has completed the token handshake, nothing but a
      // `hello` is accepted — drop everything else (it cannot be trusted).
      if (!authenticated) {
        if (msg?.type !== "hello") return;
      }

      if (msg?.type === "hello") {
        clearTimeout(handshakeTimeout);
        // Type-check BEFORE crypto: hashing a non-string would throw inside
        // this listener and take the whole bridge down, pre-auth.
        if (typeof msg.token !== "string" || !tokenMatches(msg.token, this.token)) {
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
            message: `Protocol version mismatch: extension speaks v${String(msg.protocolVersion)}, bridge speaks v${BRIDGE_PROTOCOL_VERSION}`
          }));
          this.events.onReject(
            "unsupported-version",
            `${String(msg.extVersion)} v${String(msg.protocolVersion)}`
          );
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
        // NOTE: nextRequestId is intentionally NOT reset on re-hello — the
        // random suffix already prevents collisions; resetting would only
        // widen id-reuse across the replaced session.
        this.session = {
          extensionName:
            typeof msg.extensionName === "string" && msg.extensionName ? msg.extensionName : "unknown",
          extensionVersion:
            typeof msg.extVersion === "string" && msg.extVersion ? msg.extVersion : "unknown",
          protocolVersion: msg.protocolVersion,
          remoteAddress: req.socket.remoteAddress || "127.0.0.1",
          connectedAt: Date.now()
        };
        socket.send(JSON.stringify({
          type: "hello-ack",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          bridgeVersion: this.bridgeVersion
        }));
        this.startHeartbeat(socket);
        this.events.onSessionStart(this.session);
        return;
      }

      if (msg?.type === "ping") {
        // Extension-side liveness probe (v3). Only meaningful paired — an
        // unauthenticated socket never gets here (dropped above).
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (msg?.type === "response") {
        // Forged-result protection: only the authenticated session's socket
        // may answer requests.
        if (socket !== this.socket || !this.pending.has(msg.id)) return;
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.abort?.removeEventListener("abort", p.onAbort!);
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
