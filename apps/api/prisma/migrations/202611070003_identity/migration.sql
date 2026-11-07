-- 認証済みの時刻と無操作期限を分離する。旧セッションは重要操作で再認証が必要になる。
ALTER TABLE "User" ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED'));
ALTER TABLE "User" ADD COLUMN "authVersion" integer NOT NULL DEFAULT 1 CHECK ("authVersion" > 0);
ALTER TABLE "Session" ADD COLUMN "lastActivityAt" timestamptz NOT NULL DEFAULT now();
ALTER TABLE "Session" ADD COLUMN "authenticatedAt" timestamptz;
ALTER TABLE "Session" ADD COLUMN "passkeyId" text;
ALTER TABLE "Passkey" ADD COLUMN "lastUsedAt" timestamptz;
CREATE INDEX "Session_passkeyId_idx" ON "Session"("passkeyId");

CREATE TABLE "AdminInvitation" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "codeHash" char(64) NOT NULL UNIQUE CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  name varchar(100) NOT NULL, email varchar(254) NOT NULL,
  "expiresAt" timestamptz NOT NULL, "usedAt" timestamptz, "createdById" text REFERENCES "User"(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "AdminInvitation_createdById_idx" ON "AdminInvitation"("createdById");
CREATE INDEX "AdminInvitation_expiresAt_idx" ON "AdminInvitation"("expiresAt");
CREATE TABLE "RegistrationAttempt" (
  "tokenHash" char(64) PRIMARY KEY CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  kind varchar(16) NOT NULL CHECK (kind IN ('ADD', 'INVITE', 'RECOVER')), "userId" text NOT NULL,
  version integer, "invitationId" uuid, "sessionId" text, "expiresAt" timestamptz NOT NULL,
  CHECK ((kind = 'INVITE' AND "invitationId" IS NOT NULL AND version IS NULL AND "sessionId" IS NULL) OR
    (kind = 'ADD' AND "invitationId" IS NULL AND version IS NOT NULL AND "sessionId" IS NOT NULL) OR
    (kind = 'RECOVER' AND "invitationId" IS NULL AND version IS NOT NULL AND "sessionId" IS NULL))
);
CREATE INDEX "RegistrationAttempt_userId_idx" ON "RegistrationAttempt"("userId");
CREATE INDEX "RegistrationAttempt_expiresAt_idx" ON "RegistrationAttempt"("expiresAt");
CREATE TABLE "RecoveryCode" (
  "codeHash" char(64) PRIMARY KEY CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE, "usedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- 申請元だけの資格と管理者が照合する確認コードを別に保管する。
CREATE TABLE "ReceptionApplication" (
  "tokenHash" char(64) PRIMARY KEY CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  "deviceId" uuid NOT NULL UNIQUE REFERENCES "ReceptionDevice"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "confirmationCode" char(8) NOT NULL UNIQUE CHECK ("confirmationCode" ~ '^[0-9A-F]{8}$'),
  "expiresAt" timestamptz NOT NULL, "claimedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("expiresAt" > "createdAt" AND ("claimedAt" IS NULL OR "claimedAt" >= "createdAt"))
);
CREATE INDEX "ReceptionApplication_expiresAt_idx" ON "ReceptionApplication"("expiresAt");
ALTER TABLE "ReceptionDevice" DROP CONSTRAINT "ReceptionDevice_status_check";
ALTER TABLE "ReceptionDevice" ADD CONSTRAINT "ReceptionDevice_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED'));
