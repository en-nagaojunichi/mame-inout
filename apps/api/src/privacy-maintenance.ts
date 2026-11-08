import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./db.js";
import { loadMaintenanceConfig } from "./config.js";
import { applyDeletionLedger, exportDeletionLedger, recordBackup, recordPrivacyFailure, restoreSecurity, runRetention } from "./privacy-maintenance-core.js";

async function input() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > 16 * 1024 * 1024) throw new Error("台帳の容量が上限を超えています。");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["export-ledger", "apply-ledger", "restore-ledger", "retention", "restore-security", "record-backup", "record-failure"].includes(mode ?? "")) {
    throw new Error("運用処理の種類を指定してください。");
  }
  const db = createDatabase(loadMaintenanceConfig());
  try {
    const result = mode === "export-ledger" ? await exportDeletionLedger(db)
      : mode === "apply-ledger" ? await applyDeletionLedger(db, await input())
      : mode === "restore-ledger" ? await applyDeletionLedger(db, await input(), true)
      : mode === "retention" ? await runRetention(db)
      : mode === "restore-security" ? await restoreSecurity(db)
      : mode === "record-backup" ? await recordBackup(db, await input())
      : await recordPrivacyFailure(db, await input());
    // 台帳出力はホスト側の暗号化処理への専用パイプ。通常の診断ログへ複製しない。
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("運用処理を完了できません。資格・削除台帳・外部保管先を確認してください。未確認の状態で外部公開しないでください。");
    process.exitCode = 1;
  });
}
