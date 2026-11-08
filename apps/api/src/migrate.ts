import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { loadConfig } from "./config.js";

const client = new pg.Client(loadConfig(process.env, true).database);
try {
  await client.connect();
  await client.query("SELECT pg_advisory_lock(47112)");
  await client.query('CREATE TABLE IF NOT EXISTS "SchemaMigration" (name text PRIMARY KEY, checksum text NOT NULL, "appliedAt" timestamptz NOT NULL DEFAULT now())');
  await client.query('REVOKE ALL ON TABLE "SchemaMigration" FROM mame_app');
  const directory = resolve("prisma/migrations");
  for (const name of (await readdir(directory)).sort()) {
    const sql = (await readFile(resolve(directory, name, "migration.sql"), "utf8")).replace(/^\uFEFF/, "");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ checksum: string }>('SELECT checksum FROM "SchemaMigration" WHERE name = $1', [name]);
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error("適用済みの移行は変更できません。");
      continue;
    }
    // 移行と適用記録を同時に確定し、途中失敗では次回安全に再試行する。
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query('INSERT INTO "SchemaMigration" (name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query("COMMIT");
    } catch { await client.query("ROLLBACK"); throw new Error("移行失敗"); }
  }
  console.info("DB移行が完了しました。");
} catch {
  console.error("DB移行を完了できません。接続、ロール、移行ファイルを確認してください。");
  process.exitCode = 1;
} finally { await client.end(); }
