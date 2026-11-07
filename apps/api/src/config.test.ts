import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, readSecret } from "./config.js";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mame-secret-test-"));
  directories.push(directory);
  const path = join(directory, "secret");
  writeFileSync(path, "test-only-secret-".repeat(4), { mode: 0o600 });
  return path;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true }); });

describe("秘密情報の読込", () => {
  it.skipIf(process.platform === "win32")("他ユーザーに読み取れるファイルを拒否する", () => {
    const path = fixture();
    chmodSync(path, 0o644);
    expect(() => readSecret(path)).toThrow("秘密ファイル");
  });
  it("必要なファイルを読み、欠落・空値は固定メッセージで拒否する", () => {
    const path = fixture();
    expect(readSecret(path)).toBe("test-only-secret-".repeat(4));
    writeFileSync(path, "");
    expect(() => readSecret(path)).toThrow("秘密ファイル");
    expect(() => readSecret(path + "-missing")).toThrow("秘密ファイル");
    try { readSecret(path + "-missing"); } catch (error) { expect(String(error)).not.toContain(path); }
  });
  it("本番の平文Origin・ユーザー情報入りURL・用途違いのDBロールを拒否する", () => {
    const path = fixture();
    const env = { APP_ORIGIN: "http://localhost:8080", DB_HOST: "db", DB_USER: "mame_app", DB_PASSWORD_FILE: path, AUTH_SECRET_FILE: path };
    expect(loadConfig(env).rpID).toBe("localhost");
    for (const origin of ["http://example.com", "https://user:password@example.com", "https://example.com/path"]) {
      expect(() => loadConfig({ ...env, APP_ORIGIN: origin })).toThrow();
    }
    expect(() => loadConfig({ ...env, DB_USER: "mame_migrate" })).toThrow();
    expect(() => loadConfig({ ...env, AUTH_SECRET_FILE: undefined })).toThrow();
  });
});
