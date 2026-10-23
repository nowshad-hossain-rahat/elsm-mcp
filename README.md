# elsm-mcp — local MCP bridge for Easy Local Storage Manager

`@elsm/mcp` is a local MCP (Model Context Protocol) server that lets any AI
agent — Claude Code, Cursor, Codex, Gemini CLI, ZCode, OpenCode or anything
that speaks stdio MCP — read and write the **real** browser storage
(localStorage, sessionStorage, cookies, IndexedDB) of the tab you're looking
at, through the [ELSM browser extension](https://easylocalstorage.dev).

> **Requires the browser extension.** The bridge has no storage access of its
> own — the extension is what reads and writes your browser. Install
> **Easy Local Storage Manager** from the
> [Chrome Web Store](https://chromewebstore.google.com/detail/cnmpfamlolfgahjambofnemellgdddia)
> (Firefox: build it from the
> [extension repo](https://github.com/nowshad-hossain-rahat/easy-local-storage-manager)
> and load `extension/build/firefox` unpacked).

```
Your AI agent (Claude, Codex, Cursor, ...)
        │ stdio (MCP protocol)
        ▼
  elsm-mcp  ← port 39231, pairing token in ~/.elsm-bridge/token
        │ ws://127.0.0.1:39231 (token + protocol version handshake)
        ▼
  ELSM extension (offscreen document / background page)
        │ privileged APIs (chrome.cookies, tabs, page access)
        ▼
  The active tab you are working on — its real storage
```

## Install

Three steps, in this order — the bridge is useless until the extension is
installed and paired.

### 1. Install the extension

Install **Easy Local Storage Manager** from the
[Chrome Web Store](https://chromewebstore.google.com/detail/cnmpfamlolfgahjambofnemellgdddia)
— that's where agent access, the pairing token and the **Connected agents**
screen live. Firefox: build from the
[extension repo](https://github.com/nowshad-hossain-rahat/easy-local-storage-manager).

### 2. Run the bridge

```bash
npx @elsm/mcp --port 39231
```

The first run creates a pairing token at `~/.elsm-bridge/token` (mode 0600).
Open the ELSM sidebar → **Agent access** and paste that token once per browser.

### 3. Point your MCP client at it

```json
{
  "mcpServers": {
    "elsm": {
      "command": "npx",
      "args": ["-y", "@elsm/mcp", "--port", "39231"]
    }
  }
}
```

The [setup guide](https://easylocalstorage.dev/docs) has the exact stanza for
Claude Code, Codex, Cursor, ZCode, OpenCode and a generic `mcpServers` example,
and `npx @elsm/mcp --print-config` prints them with your real paths.

## Tools

Nine tools, scoped to the active tab's origin:

| Tool | Plan | What it does |
| --- | --- | --- |
| `get_target` | Free | Tab id, URL, origin, title of the active tab |
| `list_storage_areas` | Free | Origin, storage areas present, IndexedDB database names |
| `read_storage` | Free | Read localStorage/sessionStorage — one key, a prefix, or everything |
| `read_cookies` | Free | All cookies for the tab; values `<redacted>` unless raw-value consent is granted in the UI |
| `read_indexeddb` | Free | Cursor-paged, JSON-safe read of an object store |
| `export_state` | Free | Snapshot localStorage/sessionStorage + cookie metadata (always redacted) |
| `write_storage` | Pro | Write `{key, value}` entries; every write lands in the sidebar changelog |
| `delete_keys` | Pro | Delete keys from localStorage/sessionStorage |
| `clear_area` | Pro | Wipe an area — needs `confirm: true` on a retry after the user armed Clear-all in the sidebar (60s window) |

Free plans are read-only and capped at 50 agent calls per day; Pro is
unlimited. On the extension's **Connected agents** screen you can see every
agent that called in (last used, total calls, last action), block one, or
revoke it.

## Safety model

- The WebSocket server binds **loopback only** (`127.0.0.1`) — never a
  routable interface.
- Every connection must authenticate with the pairing token as its first
  frame; non-hello frames are dropped, and token/protocol mismatches are hard
  refusals (no downgrade).
- Token comparison is hashed and constant-time; the token file is written
  atomically with mode 0600.
- No `code:` injection — all page access goes through
  `chrome.scripting.executeScript` with functions and JSON args.
- The bridge only ever talks to loopback. Note that your **agent itself** may
  send retrieved data to its LLM provider; that's between you and your agent.

## CLI

```
elsm-mcp [--port <n>] [--token-file <f>] [--print-config] [--selftest]
```

- `--port` — fixed WS port (default 39231)
- `--token-file` — pairing token file (default `~/.elsm-bridge/token`, or
  `ELSM_TOKEN_FILE`)
- `--print-config` — print paste-ready config stanzas for common clients
- `--selftest` — run the internal smoke test (real WS roundtrip: handshake,
  auth refusal, protocol-mismatch refusal, pre-auth frame dropping, agent
  attribution, session replacement) and exit

## Development

```bash
bun install
bun run build      # tsc → dist/
bun run typecheck
bun run test       # dist/cli.js --selftest
```

The wire contract with the extension is duplicated by design: the canonical
protocol types live in `src/types.ts`, and the ELSM extension repo keeps a
hand-mirrored copy
([`extension/src/shared/types/agent-bridge.types.ts`](https://github.com/nowshad-hossain-rahat/easy-local-storage-manager/blob/main/extension/src/shared/types/agent-bridge.types.ts)).
Change both in the same change and bump the protocol version in both files —
mismatches are refused at the handshake.

## Links

- **Extension (Chrome Web Store):** [cnmpfamlolfgahjambofnemellgdddia](https://chromewebstore.google.com/detail/cnmpfamlolfgahjambofnemellgdddia)
- **Setup guide:** [easylocalstorage.dev/docs](https://easylocalstorage.dev/docs)
- **Extension source:** [nowshad-hossain-rahat/easy-local-storage-manager](https://github.com/nowshad-hossain-rahat/easy-local-storage-manager)
- **Bridge source:** [nowshad-hossain-rahat/elsm-mcp](https://github.com/nowshad-hossain-rahat/elsm-mcp)

## License

MIT
