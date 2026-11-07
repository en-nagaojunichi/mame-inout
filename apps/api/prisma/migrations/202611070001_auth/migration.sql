-- 認証ライブラリのテーブルと、初期管理者を安全に確定するための状態を分ける。
CREATE TABLE "User" (
  id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  role text NOT NULL DEFAULT 'ADMIN',
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL
);
CREATE TABLE "Session" (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL,
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE TABLE "Account" (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL
);
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE TABLE "Verification" (
  id text PRIMARY KEY, identifier text NOT NULL UNIQUE, value text NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL
);
CREATE TABLE "Passkey" (
  id text PRIMARY KEY, name text, "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "credentialID" text NOT NULL UNIQUE, counter integer NOT NULL, "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL, transports text, "createdAt" timestamptz NOT NULL DEFAULT now(), aaguid text
);
CREATE INDEX "Passkey_userId_idx" ON "Passkey"("userId");
-- 初期設定は1行のみ。完了後はコードを消し、同時登録の共通ロックに使う。
CREATE TABLE "SetupState" (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1), "codeHash" text,
  "expiresAt" timestamptz, "completedAt" timestamptz
);
INSERT INTO "SetupState" (id) VALUES (1);
CREATE TABLE "SetupAttempt" (
  "tokenHash" text PRIMARY KEY, "userId" text NOT NULL UNIQUE, "codeHash" text NOT NULL,
  name text NOT NULL, email text NOT NULL, "expiresAt" timestamptz NOT NULL
);
CREATE TABLE "RateBucket" (key text PRIMARY KEY, count integer NOT NULL, "startedAt" timestamptz NOT NULL);
