#!/bin/sh
set -eu

# 初期化専用プロセスの環境から読み、秘密値を引数や標準出力へ流さない。
export MAME_APP_PASSWORD="$(cat /run/secrets/db_app_password)"
export MAME_MIGRATE_PASSWORD="$(cat /run/secrets/db_migrate_password)"
if ! psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 > /dev/null 2>&1 <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\getenv app_password MAME_APP_PASSWORD
\getenv migrate_password MAME_MIGRATE_PASSWORD
CREATE ROLE mame_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE mame_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrate_password';
REVOKE ALL ON DATABASE mame FROM PUBLIC;
GRANT CONNECT ON DATABASE mame TO mame_app, mame_migrate;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO mame_migrate;
GRANT USAGE ON SCHEMA public TO mame_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mame_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mame_app;
SQL
then
  printf '%s\n' 'DBロールの初期化に失敗しました。' >&2
  exit 1
fi
unset MAME_APP_PASSWORD MAME_MIGRATE_PASSWORD
