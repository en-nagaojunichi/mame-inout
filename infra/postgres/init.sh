#!/bin/sh
set -eu

# 初期化専用プロセスの環境から読み、秘密値を引数や標準出力へ流さない。
export MAME_APP_PASSWORD="$(cat /run/secrets/db_app_password)"
export MAME_MIGRATE_PASSWORD="$(cat /run/secrets/db_migrate_password)"
export MAME_BACKUP_PASSWORD="$(cat /run/secrets/db_backup_password)"
export MAME_MAINTENANCE_PASSWORD="$(cat /run/secrets/db_maintenance_password)"
if ! psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 > /dev/null 2>&1 <<'SQL'
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\getenv app_password MAME_APP_PASSWORD
\getenv migrate_password MAME_MIGRATE_PASSWORD
\getenv backup_password MAME_BACKUP_PASSWORD
\getenv maintenance_password MAME_MAINTENANCE_PASSWORD
CREATE ROLE mame_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE mame_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrate_password';
CREATE ROLE mame_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'backup_password';
CREATE ROLE mame_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'maintenance_password';
REVOKE ALL ON DATABASE mame FROM PUBLIC;
GRANT CONNECT ON DATABASE mame TO mame_app, mame_migrate, mame_backup, mame_maintenance;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO mame_migrate;
GRANT USAGE ON SCHEMA public TO mame_app;
GRANT USAGE ON SCHEMA public TO mame_backup, mame_maintenance;
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mame_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mame_app;
-- バックアップは読取専用、保守の変更権限は各移行で対象表へ限定して付与する。
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT ON TABLES TO mame_backup, mame_maintenance;
ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT ON SEQUENCES TO mame_backup;
SQL
then
  printf '%s\n' 'DBロールの初期化に失敗しました。' >&2
  exit 1
fi
unset MAME_APP_PASSWORD MAME_MIGRATE_PASSWORD MAME_BACKUP_PASSWORD MAME_MAINTENANCE_PASSWORD
