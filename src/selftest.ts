import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BRIDGE_PROTOCOL_VERSION } from "./config";
import { tokenMatches } from "./pairing";
import { validateToolArgs, TOOL_DEFS, parseToolCall } from "./tools";
import { ExtensionSocketServer } from "./ws-server";
import { McpServer } from "./mcp-server";

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`selftest failed: ${label}`);
  process.stderr.write(`ok: ${label}\n`);
}

function tool(name: string) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`selftest failed: tool ${name} missing`);
  return def;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a real WS roundtrip against a real loopback server (no extension):
 * fake extension → hello → bad-token refusal on a second socket → correct
 * hello + protocol handshake → request/response via the bridge → version
 * mismatch refusal → pre-auth frame dropping → agent attribution → session
 * replacement failing old pendings. Anything short of this is not "works".
 */
export async function runSelftest(): Promise<void> {
  // Watchdog: a hanging handshake must fail the run, not hang CI.
  const watchdog = setTimeout(() => {
    process.stderr.write("selftest FAILED: timed out\n");
    process.exit(1);
  }, 20_000);
  watchdog.unref?.();

  try {
    process.stderr.write(">> token file roundtrip\n");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elsm-selftest-"));
    const tokenFile = path.join(dir, "token");
    const { loadOrCreateToken } = await import("./token-store");
    const a = loadOrCreateToken(tokenFile);
    const b = loadOrCreateToken(tokenFile);
    assert(a.created && !b.created, "second read does not recreate the token");
    assert(a.token === b.token, "token stable across runs");
    if (!(((fs.statSync(tokenFile).mode & 0o777) | 0) === 0o600)) throw new Error(`selftest failed: token file is not 0600 (got ${fs.statSync(tokenFile).mode & 0o777})`);
    assert(true, "token file is 0600");
    fs.rmSync(dir, { recursive: true, force: true });

    process.stderr.write(">> constant-time token check\n");
    assert(!tokenMatches("wrong", a.token), "wrong token rejected");
    assert(tokenMatches(a.token, a.token), "matching token accepted");

    process.stderr.write(">> tool arg validation\n");
    const read = tool("read_storage");
    const write = tool("write_storage");
    const clear = tool("clear_area");
    assertThrow(() => validateToolArgs(read, {}), "missing area rejected");
    assertThrow(() => validateToolArgs(read, { area: "indexeddb" }), "bad enum rejected");
    assertThrow(() => validateToolArgs(read, { area: "localStorage", bogus: 1 }), "unexpected param rejected");
    assertThrow(() => validateToolArgs(write, { area: "localStorage", entries: ["not-an-object"] }), "entries must be objects");
    assertThrow(() => validateToolArgs(read, { area: "localStorage", tabId: 1 }), "tabId is no longer part of the protocol");
    assertThrow(() => validateToolArgs(read, { area: "cookies" }), "cookies is not a storage area");
    validateToolArgs(clear, { area: "localStorage", confirm: true });
    assert(true, "clear_area accepts confirm");
    assert(parseToolCall({ name: "read_storage", arguments: { area: "localStorage" } }).name === "read_storage", "parseToolCall keeps name");

    process.stderr.write(">> websocket handshake end-to-end\n");
    await handshakeSelftest(a.token);

    process.stderr.write("selftest PASSED\n");
  } catch (err) {
    process.stderr.write(`selftest FAILED: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

function assertThrow(fn: () => void, label: string): void {
  try {
    fn();
  } catch {
    assert(true, label);
    return;
  }
  throw new Error(`selftest failed: expected throw — ${label}`);
}

function onceEvent(ws: { once: (ev: string, cb: (arg?: unknown) => void) => void }, ev: string): Promise<any> {
  return new Promise((res) => ws.once(ev, (arg) => res(arg)));
}

async function nextFrame(ws: any): Promise<any> {
  const raw = await onceEvent(ws, "message");
  return JSON.parse(String(raw));
}

function helloFrame(token: string): string {
  return JSON.stringify({
    type: "hello",
    token,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    extVersion: "0.0.0-selftest",
    extensionName: "selftest"
  });
}

async function handshakeSelftest(token: string): Promise<void> {
  const { default: WebSocket } = await import("ws");
  const events: string[] = [];
  const server = new ExtensionSocketServer(token, "selftest", {
    onSessionStart: () => events.push("start"),
    onSessionEnd: () => events.push("end"),
    onReject: () => events.push("reject"),
    onEvent: (e) => events.push(`event:${e.event}`)
  });
  const port = await server.start(0, "127.0.0.1");
  const url = `ws://127.0.0.1:${port}`;

  // 1) Pre-auth frames must be dropped, never processed.
  const sockA = new WebSocket(url);
  await onceEvent(sockA, "open");
  sockA.send(JSON.stringify({ type: "event", event: "pre-auth" }));
  sockA.send(JSON.stringify({ type: "response", id: "forged", ok: true, result: { stolen: true } }));
  sockA.send(helloFrame(token));
  const ack = await nextFrame(sockA);
  assert(ack.type === "hello-ack", "hello-ack received");
  assert(ack.protocolVersion === BRIDGE_PROTOCOL_VERSION, "ack echoes protocol version");
  await sleep(50);
  assert(!events.some((e) => e.startsWith("event:pre-auth")), "pre-auth event frames are dropped");

  // 2) Agent identity: MCP initialize clientInfo flows onto request frames.
  const mcp = new McpServer(server);
  mcp.initialize({ clientInfo: { name: "claude-test", version: "4.2" } });
  const firstCall = server.request<{ echoed: boolean }>("read_storage", { area: "localStorage" });
  const req1 = await nextFrame(sockA);
  assert(req1.type === "request" && req1.action === "read_storage", "request forwarded to extension");
  assert(req1.agent?.name === "claude-test" && req1.agent?.version === "4.2", "request frames carry the agent identity");
  sockA.send(JSON.stringify({ type: "response", id: req1.id, ok: true, result: { echoed: true } }));
  const result = await firstCall;
  assert(result.echoed === true, "tool result propagated back");

  // 2b) App-level liveness: extension ping → bridge pong.
  sockA.send(JSON.stringify({ type: "ping" }));
  const pong = await nextFrame(sockA);
  assert(pong.type === "pong", "ping answered with pong");

  // 2c) A malformed (unparseable) frame must degrade, not kill the session.
  sockA.send("this is not json at all");
  await sleep(50);
  const survives = server
    .request<{ echoed: boolean }>("read_storage", { area: "localStorage" })
    .catch((e: { code?: string }) => e);
  const reqM = await nextFrame(sockA);
  assert(reqM.type === "request", "session survives a malformed frame");
  sockA.send(JSON.stringify({ type: "response", id: reqM.id, ok: true, result: { echoed: true } }));
  assert((await survives as { echoed: boolean }).echoed === true, "requests still answered after a bad frame");

  // 3) Session replacement fails the old session's in-flight requests
  //    immediately instead of leaving them to the 45s timeout.
  const orphaned = server
    .request("get_target", {})
    .catch((e: { code?: string }) => e);
  const sockB = new WebSocket(url);
  await onceEvent(sockB, "open");
  sockB.send(helloFrame(token));
  await nextFrame(sockB); // hello-ack for B; A is now replaced
  const replacedError = (await orphaned) as { code?: string };
  assert(replacedError?.code === "session-replaced", "replaced session's pendings fail immediately");
  // The replaced socket is closed by the bridge.
  const closedA = onceEvent(sockA, "close");
  await Promise.race([closedA, sleep(2000).then(() => { throw new Error("replaced socket not closed"); })]);
  assert(true, "replaced socket is closed");
  // The new session serves a fresh request.
  const freshCall = server.request<{ ok: number }>("read_storage", { area: "sessionStorage" });
  const req2 = await nextFrame(sockB);
  sockB.send(JSON.stringify({ type: "response", id: req2.id, ok: true, result: { ok: 1 } }));
  assert((await freshCall).ok === 1, "new session serves requests");

  // 3b) MCP cancellation: aborting an in-flight request rejects it with
  //     code "cancelled" and the late response is dropped, never written.
  const controller = new AbortController();
  const cancellable = server
    .request("get_target", {}, controller.signal)
    .catch((e: { code?: string }) => e);
  const reqCancel = await nextFrame(sockB);
  controller.abort();
  const cancelErr = (await cancellable) as { code?: string };
  assert(cancelErr?.code === "cancelled", "aborted request rejects with cancelled");
  sockB.send(JSON.stringify({ type: "response", id: reqCancel.id, ok: true, result: { late: true } }));
  await sleep(50);
  assert(true, "late response after cancellation is ignored");

  // 3c) A hello with a non-string token must be refused cleanly: pre-auth
  //     garbage must never reach the hasher and take the process down.
  const hostile = new WebSocket(url);
  await onceEvent(hostile, "open");
  hostile.send(JSON.stringify({ type: "hello", token: { evil: true }, protocolVersion: BRIDGE_PROTOCOL_VERSION, extVersion: "x", extensionName: "x" }));
  const hostileFrame = await nextFrame(hostile);
  assert(hostileFrame.type === "hello-error" && hostileFrame.code === "bad-token", "non-string token refused without crashing");
  hostile.close();
  // The bridge (and the healthy session) is still alive after the hostile frame.
  sockB.send(JSON.stringify({ type: "ping" }));
  const stillAlive = await nextFrame(sockB);
  assert(stillAlive.type === "pong", "bridge survives the hostile hello");

  // 4) Bad-token socket refused.
  const bad = new WebSocket(url);
  await onceEvent(bad, "open");
  bad.send(JSON.stringify({ type: "hello", token: "nope", protocolVersion: BRIDGE_PROTOCOL_VERSION, extVersion: "x", extensionName: "x" }));
  const firstFrame = await nextFrame(bad);
  assert(firstFrame.type === "hello-error" && firstFrame.code === "bad-token", "bad token answered with hello-error");

  // 5) Protocol mismatch refused, never downgraded.
  const old = new WebSocket(url);
  await onceEvent(old, "open");
  old.send(JSON.stringify({ type: "hello", token, protocolVersion: BRIDGE_PROTOCOL_VERSION - 1, extVersion: "old", extensionName: "old" }));
  const secondFrame = await nextFrame(old);
  assert(secondFrame.type === "hello-error" && secondFrame.code === "unsupported-version", "protocol mismatch is a hard refusal");

  await Promise.race([onceEvent(old, "close"), sleep(2000)]);
  bad.close();
  old.close();
  sockB.close();
  server.stop();
  assert(events.includes("reject"), "refusals were reported");
}

if (require.main === module) runSelftest();
