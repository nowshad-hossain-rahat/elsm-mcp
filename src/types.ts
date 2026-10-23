/**
 * Bridge ⇄ extension protocol types.
 *
 * NOTE: the extension cannot import this package (separate builds), so this
 * file is intentionally kept free of runtime code: the extension has a small
 * hand-copied mirror of the message shapes. When changing the contract, update
 * extension/src/shared/types/agent-bridge.types.ts in the same commit and
 * bump `BRIDGE_PROTOCOL_VERSION` (hard mismatch refusal on both sides).
 */

/** Identity of the MCP client (agent) an execution is attributed to. */
export interface AgentIdentity {
  name: string;
  version: string;
}

export interface HelloMessage {
  type: "hello";
  token: string;
  protocolVersion: number;
  extVersion: string;
  extensionName: string;
}

export interface HelloAckMessage {
  type: "hello-ack";
  protocolVersion: number;
  bridgeVersion: string;
}

export interface HelloErrorMessage {
  type: "hello-error";
  code: "bad-token" | "unsupported-version";
  message: string;
}

/**
 * v3 liveness probe sent by the extension on an idle timer; the bridge
 * answers immediately. Complements the bridge's protocol-level WS pings
 * (which browsers answer automatically) by letting the *extension* detect a
 * half-open socket.
 */
export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export interface BridgeRequestMessage {
  type: "request";
  id: string;
  action: BridgeAction;
  params: Record<string, unknown>;
  /** Set by the bridge from the MCP client's initialize clientInfo. */
  agent?: AgentIdentity;
}

export interface BridgeResponseMessage {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface BridgeEventMessage {
  type: "event";
  event: "disconnect" | "mutated" | string;
  payload?: unknown;
}

export type BridgeClientMessage =
  | HelloMessage
  | BridgeResponseMessage
  | BridgeEventMessage
  | PingMessage;

export type BridgeServerMessage =
  | HelloAckMessage
  | HelloErrorMessage
  | BridgeRequestMessage
  | BridgeEventMessage
  | PongMessage;

export type BridgeAction =
  | "get_target"
  | "list_storages"
  | "read_storage"
  | "write_storage"
  | "delete_keys"
  | "clear_area"
  | "read_cookies"
  | "read_indexeddb"
  | "export_state";

// ===== Param shapes (documentation of the wire contract; enforcement lives
// in tools.ts validation + the extension executor). v2 removed `tabId`: the
// active tab at call time is always the target. =====

export interface AgentStorageParams {
  area: "localStorage" | "sessionStorage";
}

export interface StorageEntry {
  key: string;
  value: string;
}

/** Result of `get_target`. */
export interface TargetResult {
  tabId: number | null;
  url: string;
  origin: string;
  title: string;
  protocolVersion: number;
}

/** Result of `list_storages`. */
export interface StoragesResult {
  origin: string;
  localStorageKeys: number;
  sessionStorageKeys: number;
  indexedDbNames: string[];
  cookieAccess: boolean;
}

export interface IndexDbPage {
  db: string;
  store: string;
  count: number;
  nextCursor: number | null;
  records: Array<{ key: string; value: unknown }>;
}
