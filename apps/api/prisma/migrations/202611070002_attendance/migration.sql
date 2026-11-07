-- 既存認証の資格・パスキーは変更せず、業務データを別のテーブルへ追加する。
CREATE TABLE "Facility" (
  id integer PRIMARY KEY DEFAULT 1 CONSTRAINT "Facility_singleton_check" CHECK (id = 1),
  name varchar(100) NOT NULL DEFAULT '施設',
  "timeZone" varchar(100) NOT NULL DEFAULT 'Asia/Tokyo',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Facility_name_check" CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT "Facility_timeZone_check" CHECK (char_length(btrim("timeZone")) BETWEEN 1 AND 100)
);
INSERT INTO "Facility" (id) VALUES (1);

CREATE TABLE "Person" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "facilityId" integer NOT NULL DEFAULT 1 REFERENCES "Facility"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "displayName" varchar(100) NOT NULL,
  "phoneticName" varchar(100),
  affiliation varchar(100),
  code varchar(64),
  status varchar(16) NOT NULL DEFAULT 'ACTIVE',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Person_displayName_check" CHECK (char_length(btrim("displayName")) BETWEEN 1 AND 100),
  CONSTRAINT "Person_code_check" CHECK (code IS NULL OR char_length(btrim(code)) BETWEEN 1 AND 64),
  CONSTRAINT "Person_status_check" CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  CONSTRAINT "Person_facilityId_code_key" UNIQUE ("facilityId", code)
);
CREATE INDEX "Person_facilityId_status_displayName_idx" ON "Person"("facilityId", status, "displayName");

CREATE TABLE "QrCredential" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "personId" uuid NOT NULL REFERENCES "Person"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" char(64) NOT NULL UNIQUE,
  "issuedAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz,
  CONSTRAINT "QrCredential_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "QrCredential_personId_idx" ON "QrCredential"("personId");
-- 失効済みの履歴を残しながら、現に使えるQRだけを1件に限定する。
CREATE UNIQUE INDEX "QrCredential_one_active_per_person" ON "QrCredential"("personId") WHERE "revokedAt" IS NULL;

CREATE TABLE "ReceptionDevice" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "facilityId" integer NOT NULL DEFAULT 1 REFERENCES "Facility"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  name varchar(100) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'PENDING',
  "expiresAt" timestamptz,
  "approvedAt" timestamptz,
  "approvedById" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "revokedAt" timestamptz,
  "lastUsedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ReceptionDevice_name_check" CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT "ReceptionDevice_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'REVOKED')),
  CONSTRAINT "ReceptionDevice_approval_check" CHECK (status <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "expiresAt" IS NOT NULL))
);
CREATE INDEX "ReceptionDevice_facilityId_status_idx" ON "ReceptionDevice"("facilityId", status);
CREATE INDEX "ReceptionDevice_approvedById_idx" ON "ReceptionDevice"("approvedById");
CREATE INDEX "ReceptionDevice_expiresAt_idx" ON "ReceptionDevice"("expiresAt");

CREATE TABLE "ReceptionCredential" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "deviceId" uuid NOT NULL REFERENCES "ReceptionDevice"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" char(64) NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ReceptionCredential_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "ReceptionCredential_deviceId_idx" ON "ReceptionCredential"("deviceId");
CREATE INDEX "ReceptionCredential_expiresAt_idx" ON "ReceptionCredential"("expiresAt");

CREATE TABLE "AttendanceVisit" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "personId" uuid NOT NULL REFERENCES "Person"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "enteredAt" timestamptz NOT NULL,
  "exitedAt" timestamptz,
  "canceledAt" timestamptz,
  version integer NOT NULL DEFAULT 1,
  source varchar(16) NOT NULL DEFAULT 'RECEPTION',
  "createdByDeviceId" uuid REFERENCES "ReceptionDevice"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "createdByUserId" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "AttendanceVisit_times_check" CHECK ("exitedAt" IS NULL OR "exitedAt" >= "enteredAt"),
  CONSTRAINT "AttendanceVisit_version_check" CHECK (version > 0),
  CONSTRAINT "AttendanceVisit_source_check" CHECK (source IN ('RECEPTION', 'MANUAL'))
);
-- 同時入室がアプリ側の判定を通過しても、未終了の在室は利用者ごとに最大1件にする。
CREATE UNIQUE INDEX "AttendanceVisit_one_open_per_person" ON "AttendanceVisit"("personId") WHERE "exitedAt" IS NULL AND "canceledAt" IS NULL;
CREATE INDEX "AttendanceVisit_personId_enteredAt_idx" ON "AttendanceVisit"("personId", "enteredAt" DESC);
CREATE INDEX "AttendanceVisit_enteredAt_idx" ON "AttendanceVisit"("enteredAt" DESC);
CREATE INDEX "AttendanceVisit_createdByDeviceId_idx" ON "AttendanceVisit"("createdByDeviceId");
CREATE INDEX "AttendanceVisit_createdByUserId_idx" ON "AttendanceVisit"("createdByUserId");

CREATE TABLE "AttendanceRequest" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "deviceId" uuid NOT NULL REFERENCES "ReceptionDevice"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "issuedAt" timestamptz NOT NULL DEFAULT now(),
  "acceptUntil" timestamptz NOT NULL,
  "resultUntil" timestamptz NOT NULL,
  "payloadHash" char(64),
  "httpStatus" integer,
  response jsonb,
  "personId" uuid REFERENCES "Person"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "completedAt" timestamptz,
  CONSTRAINT "AttendanceRequest_times_check" CHECK ("issuedAt" < "acceptUntil" AND "acceptUntil" <= "resultUntil"),
  CONSTRAINT "AttendanceRequest_payloadHash_check" CHECK ("payloadHash" IS NULL OR "payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "AttendanceRequest_result_check" CHECK (
    ("payloadHash" IS NULL AND "httpStatus" IS NULL AND response IS NULL AND "completedAt" IS NULL)
    OR
    ("payloadHash" IS NOT NULL AND "httpStatus" IS NOT NULL AND "httpStatus" IN (200, 409) AND response IS NOT NULL AND jsonb_typeof(response) = 'object' AND "completedAt" IS NOT NULL)
  )
);
CREATE INDEX "AttendanceRequest_deviceId_issuedAt_idx" ON "AttendanceRequest"("deviceId", "issuedAt" DESC);
CREATE INDEX "AttendanceRequest_resultUntil_idx" ON "AttendanceRequest"("resultUntil");
CREATE INDEX "AttendanceRequest_personId_idx" ON "AttendanceRequest"("personId");

CREATE TABLE "AttendanceRevision" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "visitId" uuid NOT NULL REFERENCES "AttendanceVisit"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorUserId" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  reason varchar(500) NOT NULL,
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "AttendanceRevision_reason_check" CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT "AttendanceRevision_snapshot_check" CHECK (jsonb_typeof("before") IN ('object', 'null') AND jsonb_typeof("after") = 'object')
);
CREATE INDEX "AttendanceRevision_visitId_createdAt_idx" ON "AttendanceRevision"("visitId", "createdAt" DESC);
CREATE INDEX "AttendanceRevision_actorUserId_idx" ON "AttendanceRevision"("actorUserId");

CREATE TABLE "AuditEvent" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action varchar(64) NOT NULL,
  "actorType" varchar(16) NOT NULL,
  "actorUserId" text REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "deviceId" uuid REFERENCES "ReceptionDevice"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "personId" uuid REFERENCES "Person"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "visitId" uuid REFERENCES "AttendanceVisit"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "requestId" uuid REFERENCES "AttendanceRequest"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "AuditEvent_action_check" CHECK (char_length(btrim(action)) BETWEEN 1 AND 64),
  CONSTRAINT "AuditEvent_actorType_check" CHECK ("actorType" IN ('ADMIN', 'RECEPTION', 'SYSTEM')),
  CONSTRAINT "AuditEvent_details_check" CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt" DESC);
CREATE INDEX "AuditEvent_deviceId_createdAt_idx" ON "AuditEvent"("deviceId", "createdAt" DESC);
CREATE INDEX "AuditEvent_personId_createdAt_idx" ON "AuditEvent"("personId", "createdAt" DESC);
CREATE INDEX "AuditEvent_visitId_idx" ON "AuditEvent"("visitId");
CREATE INDEX "AuditEvent_requestId_idx" ON "AuditEvent"("requestId");
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- 日常のAPIでは追記と参照だけを認め、監査・訂正の前後記録を上書きさせない。
-- 保持期限の削除や復元は、後続の専用運用権限で扱う。
REVOKE UPDATE, DELETE ON TABLE "AuditEvent", "AttendanceRevision" FROM mame_app;
