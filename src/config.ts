export const BRIDGE_PROTOCOL_VERSION = 2;
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

/** Bridge package version — overwritten at build time from package.json. */
export const BRIDGE_VERSION = "0.1.0";

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
 * Web-storage areas the bridge exposes for read/write/delete/clear. Cookies
 * are not an area here: they are the separate read_cookies tool (chrome.cookies
 * access, values redacted until the user grants raw-value consent in the UI).
 */
export const STORAGE_AREAS = ["localStorage", "sessionStorage"] as const;
