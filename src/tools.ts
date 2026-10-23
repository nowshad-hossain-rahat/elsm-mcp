import * as crypto from "crypto";
import { REQUEST_MAX_BYTES, STORAGE_AREAS } from "./config";
import type { BridgeAction } from "./types";
import type { StorageArea } from "./types-style";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  action: BridgeAction;
}

const areaSchema = {
  type: "string",
  enum: ["localStorage", "sessionStorage"]
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "list_storage_areas",
    description:
      "List what the bridge can operate on for the current target: origin, storage areas present, IndexedDB database names.",
    inputSchema: { type: "object", properties: {} },
    action: "list_storages"
  },
  {
    name: "get_target",
    description:
      "Describe the active target the agent is operating on: tab id, URL and origin, title. No secrets.",
    inputSchema: { type: "object", properties: {} },
    action: "get_target"
  },
  {
    name: "read_storage",
    description:
      "Read keys from localStorage or sessionStorage of the active tab's origin. Params: area (required), key (single key) or prefix (all keys beginning with the prefix); omit both for everything. (Cookies are not an area here — use read_cookies.)",
    inputSchema: {
      type: "object",
      properties: {
        area: areaSchema,
        key: { type: "string" },
        prefix: { type: "string" }
      },
      required: ["area"]
    },
    action: "read_storage"
  },
  {
    name: "read_cookies",
    description:
      "Read all cookies visible to the active tab (name, domain, path, secure, httpOnly, sameSite, session). Params: rawCookieValues (boolean) — values are returned as \"<redacted>\" unless the user has explicitly granted raw-value consent in the extension UI; without consent the call still succeeds but values stay redacted.",
    inputSchema: {
      type: "object",
      properties: { rawCookieValues: { type: "boolean" } },
      required: []
    },
    action: "read_cookies"
  },
  {
    name: "write_storage",
    description:
      "Write entries into localStorage or sessionStorage of the active tab's origin. Params: area (required), entries ([{key, value}] as JSON-serializable strings). Every write is appended to the sidebar changelog so the user sees it.",
    inputSchema: {
      type: "object",
      properties: { area: areaSchema, entries: { type: "array", items: { type: "object" } } },
      required: ["area", "entries"]
    },
    action: "write_storage"
  },
  {
    name: "delete_keys",
    description:
      "Delete keys from localStorage or sessionStorage on the active tab's origin. Params: area (required), keys (required array).",
    inputSchema: {
      type: "object",
      properties: { area: areaSchema, keys: { type: "array", items: { type: "string" } } },
      required: ["area", "keys"]
    },
    action: "delete_keys"
  },
  {
    name: "clear_area",
    description:
      "Clear an entire area (every key) for the active tab's origin. Destructive: requires BOTH (1) confirm: true in the call — pass it on the retry after receiving needsConfirmation — and (2) the user pressing 'Clear' in the ELSM sidebar Agent panel within 60s before the retry. Params: area (required), confirm (boolean).",
    inputSchema: {
      type: "object",
      properties: { area: areaSchema, confirm: { type: "boolean" } },
      required: ["area"]
    },
    action: "clear_area"
  },
  {
    name: "read_indexeddb",
    description:
      "Cursor-paged, JSON-safe read of an IndexedDB object store on the active tab's origin. Params: db (required), store (required), cursor (number offset from a previous call's nextCursor), limit (default 200, max 1000).",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string" },
        store: { type: "string" },
        cursor: { type: "number" },
        limit: { type: "number" }
      },
      required: ["db", "store"]
    },
    action: "read_indexeddb"
  },
  {
    name: "export_state",
    description:
      "Export the storage snapshot of the active tab's origin: origin, localStorage, sessionStorage, and cookie metadata (cookie values always redacted). Params: rawCookieValues (boolean, ignored — kept for compatibility).",
    inputSchema: {
      type: "object",
      properties: { rawCookieValues: { type: "boolean" } },
      required: []
    },
    action: "export_state"
  }
];

export interface McpToolCall {
  name: string;
  args: unknown;
}

export function parseToolCall(raw: unknown): McpToolCall {
  const params = (raw ?? {}) as Record<string, unknown>;
  if (typeof params.name !== "string") {
    throw new Error("tools/call is missing a string `name`");
  }
  return { name: params.name, args: params.arguments ?? {} };
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Validate agent args against the tool's JSON-schema subset. Throws an Error
 * whose message is returned to the agent as a tool error — never a crash.
 */
export function validateToolArgs(def: ToolDef, args: Record<string, unknown>): void {
  for (const key of def.inputSchema.required ?? []) {
    if (args[key] === undefined) {
      throw new Error(`Missing required param "${key}" for tool ${def.name}`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > REQUEST_MAX_BYTES) {
    throw new Error(`Tool arguments exceed ${REQUEST_MAX_BYTES} bytes`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = def.inputSchema.properties[key] as Record<string, unknown> | undefined;
    if (!schema) {
      throw new Error(`Unexpected param "${key}" for tool ${def.name}`);
    }
    const type = (schema.type as string) ?? "any";
    if (Array.isArray(schema.enum)) {
      if (schema.enum.indexOf(value) < 0) {
        throw new Error(`Param "${key}" must be one of ${JSON.stringify(schema.enum)}`);
      }
    } else if (type !== "any" && !matchesType(value, type)) {
      throw new Error(`Param "${key}" must be of type ${type}`);
    }
    if (schema.items && type === "array") {
      const itemType = ((schema.items as Record<string, unknown>).type as string) ?? "any";
      for (const item of value as unknown[]) {
        if (!matchesType(item, itemType)) {
          throw new Error(`Every element of "${key}" must be of type ${itemType}`);
        }
      }
    }
  }
  // area must be one the bridge actually speaks
  if (typeof args.area === "string" && (STORAGE_AREAS as readonly string[]).indexOf(args.area) < 0) {
    throw new Error(`"area" must be one of ${JSON.stringify(STORAGE_AREAS)}`);
  }
}

export function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export type { StorageArea };
