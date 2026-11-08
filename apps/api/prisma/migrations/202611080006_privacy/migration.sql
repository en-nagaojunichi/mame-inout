-- 指示はバックアップの世代を越えて再適用するため、利用者の物理削除と連動させない。
CREATE TABLE "PrivacyState" (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  "deploymentId" uuid NOT NULL DEFAULT gen_random_uuid(),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  "lastBackupAt" timestamptz,
  "backupExternalConfirmed" boolean NOT NULL DEFAULT false
);
INSERT INTO "PrivacyState" (id) VALUES (1);
CREATE TABLE "RetentionPolicy" (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  days integer NOT NULL DEFAULT 365 CHECK (days BETWEEN 1 AND 3650),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  "backupRetentionDays" integer NOT NULL DEFAULT 30 CHECK ("backupRetentionDays" BETWEEN 1 AND 3650),
  "lastRunAt" timestamptz,
  "lastDeletedVisits" integer NOT NULL DEFAULT 0 CHECK ("lastDeletedVisits" >= 0),
  "lastDeletedAuditEvents" integer NOT NULL DEFAULT 0 CHECK ("lastDeletedAuditEvents" >= 0)
);
INSERT INTO "RetentionPolicy" (id) VALUES (1);
CREATE TABLE "DeletionInstruction" (
  "operationId" uuid PRIMARY KEY,
  sequence integer NOT NULL UNIQUE CHECK (sequence > 0),
  "personId" uuid NOT NULL UNIQUE,
  "requestedAt" timestamptz NOT NULL
);
CREATE TABLE "DeletionProgress" (
  "operationId" uuid PRIMARY KEY REFERENCES "DeletionInstruction"("operationId") ON DELETE RESTRICT,
  "completedAt" timestamptz,
  "lastAttemptAt" timestamptz,
  "errorCode" varchar(40) CHECK ("errorCode" IS NULL OR "errorCode" IN ('EXTERNAL_STORAGE_UNAVAILABLE', 'ERASURE_FAILED'))
);

-- 通常APIには処理済みの偽装・指示の消去・保持処理による履歴削除を許さない。
REVOKE ALL ON "PrivacyState", "RetentionPolicy", "DeletionInstruction", "DeletionProgress" FROM mame_app;
GRANT SELECT ON "PrivacyState", "RetentionPolicy", "DeletionInstruction", "DeletionProgress" TO mame_app;
GRANT UPDATE (generation) ON "PrivacyState" TO mame_app;
GRANT UPDATE (days, version) ON "RetentionPolicy" TO mame_app;
GRANT INSERT ON "DeletionInstruction" TO mame_app;

-- このロールは初期化または更新前の管理者処理で作成する。通常APIへは渡さない。
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mame_maintenance;
GRANT UPDATE ON "PrivacyState", "RetentionPolicy", "Person", "QrCredential", "ReceptionDevice", "ReceptionCredential", "AttendanceRequest", "AttendanceRevision", "AuditEvent", "SetupState" TO mame_maintenance;
GRANT INSERT ON "DeletionInstruction", "DeletionProgress", "AuditEvent" TO mame_maintenance;
GRANT UPDATE ON "DeletionProgress" TO mame_maintenance;
GRANT DELETE ON "QrCredential", "AttendanceRequest", "AttendanceRevision", "AttendanceVisit", "AuditEvent", "Session", "Passkey", "RecoveryCode", "RegistrationAttempt", "SetupAttempt", "AdminInvitation", "Verification", "ReceptionApplication" TO mame_maintenance;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mame_backup;
