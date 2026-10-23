import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function defaultTokenFile(): string {
  return path.join(os.homedir(), ".elsm-bridge", "token");
}

export interface TokenResult {
  token: string;
  created: boolean;
}

/** Warn-only stderr writer (keeps stdout clean for the MCP wire). */
function warn(line: string): void {
  process.stderr.write(`[elsm-mcp] ${line}\n`);
}

/** Remove `token.<pid>.tmp` leftovers from crashed runs (older than an hour, so a concurrently creating process is never robbed). */
function sweepStaleTmp(dir: string, base: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const prefix = `${base}.`;
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs > 3_600_000) fs.unlinkSync(full);
    } catch {
      /* someone else cleaned it up first */
    }
  }
}

/** Load the pairing token, or create one atomically (0600, umask-proof). */
export function loadOrCreateToken(file: string): TokenResult {
  const dir = path.dirname(file);
  const base = path.basename(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  sweepStaleTmp(dir, base);

  // Read path. Reading first (instead of existsSync) closes most of the
  // create/create race; the link() below closes the rest.
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf-8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  if (existing !== null) {
    if (existing.length < 32) {
      throw new Error(`Token file ${file} looks corrupt (short). Delete it and re-run.`);
    }
    // Token integrity is enforced, not just checked: a user-relaxed mode
    // would let every other local user read the pairing secret.
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) {
      fs.chmodSync(file, 0o600);
      warn(`Token file ${file} had mode ${mode.toString(8)} — reset to 0600`);
    }
    return { token: existing, created: false };
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // umask can erode the mode; state the intent
  try {
    // link() never overwrites: if two bridges create concurrently, exactly
    // one wins and the other re-reads the winner's token instead of keeping
    // an in-memory secret that no longer exists on disk.
    fs.linkSync(tmp, file);
    fs.unlinkSync(tmp);
    return { token, created: true };
  } catch (err) {
    fs.unlinkSync(tmp);
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const winner = fs.readFileSync(file, "utf-8").trim();
      if (winner.length < 32) {
        throw new Error(`Token file ${file} looks corrupt (short). Delete it and re-run.`);
      }
      return { token: winner, created: false };
    }
    throw err;
  }
}
