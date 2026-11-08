-- 単一設置の表示設定を追加し、既存の認証・施設・業務データには触れない。
CREATE TABLE "Appearance" (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  "displayName" varchar(64) NOT NULL DEFAULT '入退出管理システム',
  icon bytea,
  favicon bytea,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "Appearance_displayName_check" CHECK (char_length(btrim("displayName")) BETWEEN 1 AND 64 AND "displayName" !~ '[[:cntrl:]]'),
  CONSTRAINT "Appearance_icon_size_check" CHECK (icon IS NULL OR octet_length(icon) BETWEEN 1 AND 65536),
  CONSTRAINT "Appearance_favicon_size_check" CHECK (favicon IS NULL OR octet_length(favicon) BETWEEN 1 AND 65536)
);
INSERT INTO "Appearance" (id) VALUES (1);
-- 誤操作で設定行を失わず、画像と監査は通常APIのトランザクションで更新する。
REVOKE DELETE ON TABLE "Appearance" FROM mame_app;
