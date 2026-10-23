export const BRIDGE_PROTOCOL_VERSION = 3;
export const DEFAULT_PORT = 39231;
export const DEFAULT_HOST = "127.0.0.1";
export const REQUEST_TIMEOUT_MS = 45_000;
export const MCP_SERVER_NAME = "elsm-mcp";
export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];
/** Largest supported MCP protocol version this bridge speaks. */
export const MCP_LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

/** Bridge package version — read from package.json so there is one truth. */
export const BRIDGE_VERSION: string = (() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("../package.json") as { version?: string };
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
})();

/** Env+argv-controllable pieces. */
export const TOKEN_FILE_ENV = "ELSM_TOKEN_FILE";
export const WS_HOST = DEFAULT_HOST;
/** Largest tool payload accepted from the agent (bytes of JSON). */
export const REQUEST_MAX_BYTES = 128 * 1024;
/**
 * ws `maxPayload` for frames received from the extension (responses). The
 * executor truncates results to MAX_RESULT_BYTES before responding; this is
 * the hard transport backstop, so it leaves headroom above that.
 */
export const WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Dead-socket detection: the bridge pings the paired socket at this interval
 * and terminates it if no pong arrived since the previous ping. Browsers
 * answer protocol-level pings automatically, so the extension needs no code
 * for this direction.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Send-buffer cap for requests headed to the extension. Past this, the
 * extension is not draining (stalled tab, half-open pipe) and queueing more
 * only trades bounded memory for latency — fail fast instead.
 */
export const SEND_BUFFER_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Malformed (unparseable) frames tolerated per connection before closing it:
 * a stray truncated frame should not kill a session, but endless garbage is
 * a broken peer.
 */
export const MAX_BAD_FRAMES_PER_CONNECTION = 10;

/**
 * Web-storage areas the bridge exposes for read/write/delete/clear. Cookies
 * are not an area here: they are the separate read_cookies tool (chrome.cookies
 * access, values redacted until the user grants raw-value consent in the UI).
 */
export const STORAGE_AREAS = ["localStorage", "sessionStorage"] as const;
