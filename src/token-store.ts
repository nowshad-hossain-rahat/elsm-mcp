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

/** Load the pairing token, or create one atomically (0600, umask-proof). */
export function loadOrCreateToken(file: string): TokenResult {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, "utf-8").trim();
    if (token.length < 32) {
      throw new Error(`Token file ${file} looks corrupt (short). Delete it and re-run.`);
    }
    return { token, created: false };
  }
  const token = crypto.randomBytes(24).toString("base64url");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // umask can erode the mode; state the intent
  fs.renameSync(tmp, file);
  return { token, created: true };
}
