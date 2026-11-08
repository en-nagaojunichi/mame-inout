#!/usr/bin/env python3
"""固定配布物の導入、暗号化保管、更新、隔離復元を案内するLinux用コマンド。"""

import argparse
import base64
from datetime import datetime, timezone
import json
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import uuid

# 読取専用の配布物へキャッシュを追加せず、同梱manifestとの一致を保つ。
sys.dont_write_bytecode = True

from operations_lib import (OperationError, atomic, canonical, check_port, decrypt, digest, encrypt,
                            file_digest, fingerprint, locked, remote, run, secure_path, validate_ledger, validate_prefix)


SECRETS = ("db_admin_password", "db_app_password", "db_migrate_password", "db_backup_password", "db_maintenance_password", "auth_secret")
ENGINE = ["docker", "--host", "unix:///var/run/docker.sock"]
MAX_BACKUP = 256 * 1024 * 1024
_SOURCE_CACHE = {}


class ErasureError(OperationError):
    pass


def say(value):
    print(value, flush=True)


def source(config):
    if config["release"] in _SOURCE_CACHE:
        return _SOURCE_CACHE[config["release"]]
    release = Path(config["release"])
    if not release.is_absolute() or release != release.resolve() or release.is_symlink():
        raise OperationError("配布物の絶対パスとリンクを確認してください。")
    manifest = json.loads((release / "manifest.json").read_bytes())
    if manifest.get("format") != 1 or not isinstance(manifest.get("files"), dict) or set(manifest.get("images", {})) != {"api", "web", "postgres", "proxy"}:
        raise OperationError("対応する固定配布物のmanifest.jsonが必要です。")
    directory = release / "source"
    actual = set()
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise OperationError("配布物にリンクは使用できません。")
        if path.is_file():
            relative = path.relative_to(directory).as_posix()
            actual.add(relative)
            if manifest["files"].get(relative) != digest(path.read_bytes()):
                raise OperationError("配布物のファイルが一致しません。展開し直してください。")
    if actual != set(manifest["files"]) or file_digest(release / "images.tar") != manifest["imagesSha256"]:
        raise OperationError("配布物の内容またはイメージの指紋が一致しません。")
    for key, image in manifest["images"].items():
        if set(image) != {"reference", "id"} or not re.fullmatch(r"sha256:[0-9a-f]{64}", image["id"]):
            raise OperationError("固定イメージの識別情報が不正です。")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/@:-]+", image["reference"]) or image["reference"].endswith((":latest", ":dev")):
            raise OperationError("起動時に変わらないイメージを指定してください。")
        if key == "postgres" and image["reference"] != "postgres:18.6-bookworm" or key == "proxy" and image["reference"] != "caddy:2.11.9-alpine":
            raise OperationError("この版が検証したPostgreSQL・プロキシのイメージが必要です。")
    _SOURCE_CACHE[config["release"]] = (directory, manifest)
    return directory, manifest


def load(path, *, allow_unbound=False):
    secure_path(path)
    config = json.loads(Path(path).read_bytes())
    required = {"format", "project", "release", "state", "origin", "port", "externalHost", "externalRoot", "externalHostId", "ledgerPublicKey", "backupPublicKey"}
    if set(config) - {"networkSubnets"} != required or config["format"] != 1 or not re.fullmatch(r"mame-inout-[a-z0-9-]{1,40}", config["project"]):
        raise OperationError("設定ファイルの形式または専用プロジェクト名が不正です。")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::\d+)?", config["origin"]) or type(config["port"]) is not int or not 1024 <= config["port"] <= 65535:
        raise OperationError("公開HTTPSのURLまたは内部ポートを確認してください。")
    if not re.fullmatch(r"[0-9a-f]{64}", config["externalHostId"]) and not (allow_unbound and config["externalHostId"] == ""):
        raise OperationError("外部保管の準備が完了していません。先にconfigureを再実行してください。")
    secure_path(config["state"], directory=True)
    for key in ("ledgerPublicKey", "backupPublicKey"):
        secure_path(config[key])
    if fingerprint(config["ledgerPublicKey"]) == fingerprint(config["backupPublicKey"]):
        raise OperationError("削除台帳とDBバックアップには別の暗号化鍵を使用してください。")
    return config


def configure(path):
    pending_path = Path(str(path) + ".pending")
    if Path(path).exists():
        config = load(path, allow_unbound=True)
        if config["externalHostId"]:
            raise OperationError("既存の設定は上書きしません。diagnoseで確認してください。")
        response = remote(config, "check", str(uuid.uuid4()))
        config["externalHostId"] = response["hostId"]
        atomic(Path(path), canonical(config))
        say("外部保管の接続確認を再開し、準備が完了しました。次にdiagnoseを実行してください。")
        return
    if pending_path.exists():
        pending = json.loads(secure_path(pending_path).read_bytes())
        finish_configuration(path, pending["config"], pending["existingSecrets"], pending_path)
        return
    say("導入の準備です。秘密の内容を入力する必要はありません。")
    prompts = [("project", "専用プロジェクト名（例 mame-inout-facility）"), ("release", "展開した配布物の絶対パス"),
               ("state", "新しく作る専用保管先の絶対パス（例 /var/lib/mame-inout-facility）"), ("origin", "利用者が開くHTTPSのURL（末尾/なし）"),
               ("port", "既存サービスが使っていない内部ポート（例 18082）"), ("externalHost", "別サーバーのSSH接続名"),
               ("externalRoot", "別サーバーに準備した0700保管先の絶対パス"), ("ledgerPublicKey", "削除台帳の暗号化用公開鍵ファイルの絶対パス"),
               ("backupPublicKey", "DBバックアップの暗号化用公開鍵ファイルの絶対パス")]
    config = {"format": 1, "externalHostId": ""}
    for key, prompt in prompts:
        config[key] = input(prompt + ": ").strip()
    config["port"] = int(config["port"])
    existing_secrets = input("既存環境から更新する場合だけ、現在の秘密ファイルフォルダーの絶対パス（新規導入は空欄）: ").strip()
    state = Path(config["state"])
    if not state.is_absolute() or state != state.resolve() or state.exists():
        raise OperationError("保管先は、まだ存在しない専用の絶対パスにしてください。")
    source(config)
    # 作成先が空であることを確認してから計画を先に残し、途中失敗後も既存値を守って再開する。
    atomic(pending_path, canonical({"config": config, "existingSecrets": existing_secrets}))
    finish_configuration(path, config, existing_secrets, pending_path)


def finish_configuration(path, config, existing_secrets, pending_path):
    state = Path(config["state"])
    if not state.exists():
        state.mkdir(mode=0o700)
    secure_path(state, directory=True)
    if set(item.name for item in state.iterdir()) - {"secrets"}:
        raise OperationError("準備途中の保管先に未知のファイルがあります。上書きせず確認してください。")
    secrets_directory = state / "secrets"
    if not secrets_directory.exists():
        secrets_directory.mkdir(mode=0o700)
        os.chown(secrets_directory, 1000, 1000)
    secure_path(secrets_directory, directory=True, owner=1000)
    if set(item.name for item in secrets_directory.iterdir()) - set(SECRETS):
        raise OperationError("準備途中の秘密フォルダーに未知のファイルがあります。")
    for name in SECRETS:
        existing = Path(existing_secrets) / name if existing_secrets else None
        if existing and existing.exists():
            secure_path(existing, owner=1000)
            value = existing.read_bytes()
            if not 32 <= len(value) <= 4096 or b"\n" in value or b"\r" in value:
                raise OperationError("既存の秘密ファイルの形式を確認してください。")
        elif existing_secrets and name in ("db_admin_password", "db_app_password", "db_migrate_password", "auth_secret"):
            raise OperationError("既存環境の必要な秘密ファイルが不足しています。再生成せず、元の場所を確認してください。")
        else:
            value = secrets.token_urlsafe(48).encode("ascii")
        target = secrets_directory / name
        if target.exists():
            current = secure_path(target, owner=1000).read_bytes()
            if not 32 <= len(current) <= 4096 or existing and existing.exists() and current != value:
                raise OperationError("準備途中の秘密ファイルを確認してください。既存値は上書きしません。")
        else:
            atomic(target, value, owner=1000)
    atomic(Path(path), canonical(config))
    pending_path.unlink()
    config = load(path, allow_unbound=True)
    # 外部保管は初回から別ホストと固定し、同じVPS内のコピーを外部保管扱いしない。
    response = remote(config, "check", str(uuid.uuid4()))
    config["externalHostId"] = response["hostId"]
    atomic(Path(path), canonical(config))
    say("準備できました。次に diagnose を実行してください。既存のサービスは変更していません。")


def environment(config, manifest):
    state = Path(config["state"])
    # envファイルは公開値と秘密ファイルの参照だけ。値をcompose出力へ混ぜない。
    values = {"APP_ORIGIN": config["origin"], "HTTP_PORT": str(config["port"]), "SECRETS_DIR": str(state / "secrets"),
              "API_IMAGE": manifest["images"]["api"]["reference"], "WEB_IMAGE": manifest["images"]["web"]["reference"]}
    if any("\n" in value or "\r" in value or "'" in value for value in values.values()):
        raise OperationError("設定の値に使用できない文字があります。")
    target = state / "runtime.env"
    atomic(target, "".join(key + "='" + value + "'\n" for key, value in values.items()).encode("utf-8"))
    return target


def compose(config, *arguments, data=None, timeout=300):
    directory, manifest = source(config)
    runtime = environment(config, manifest)
    files = ["-f", str(directory / "compose.yaml"), "-f", str(directory / "compose.nginx.yaml")]
    if config.get("networkSubnets"):
        subnets = config["networkSubnets"]
        if set(subnets) != {"edge", "database"}:
            raise OperationError("専用ネットワークにはedgeとdatabaseを指定してください。")
        parsed = {name: ipaddress.ip_network(value, strict=True) for name, value in subnets.items()}
        if any(not value.is_private or value.version != 4 or value.prefixlen != 24 for value in parsed.values()) or parsed["edge"].overlaps(parsed["database"]):
            raise OperationError("重複しない専用のプライベートIPv4 /24ネットワークを指定してください。")
        override = Path(config["state"]) / "network.yaml"
        atomic(override, ("networks:\n" + "".join("  " + name + ":\n    ipam:\n      config: [{subnet: '" + str(value) + "'}]\n" for name, value in parsed.items())).encode("ascii"))
        files += ["-f", str(override)]
    return run(ENGINE + ["compose", "--project-name", config["project"], "--project-directory", str(directory), "--env-file", str(runtime), *files, *arguments], data=data, timeout=timeout)


def container(config, service, *, optional=False):
    output = compose(config, "ps", "--all", "--quiet", service).decode().strip()
    if optional and not output:
        return None
    if not re.fullmatch(r"[0-9a-f]{12,64}", output):
        raise OperationError("対象サービスを一意に確認できません。")
    item = json.loads(run(ENGINE + ["inspect", output]))[0]
    labels = item["Config"]["Labels"]
    if labels.get("com.docker.compose.project") != config["project"] or labels.get("com.docker.compose.service") != service:
        raise OperationError("対象プロジェクトのコンテナではありません。")
    if service == "db":
        _, manifest = source(config)
        if item["Image"] != manifest["images"]["postgres"]["id"] or item["HostConfig"].get("PortBindings"):
            raise OperationError("この配布物に対応する、外部非公開の専用PostgreSQLではありません。")
        data = [mount for mount in item["Mounts"] if mount["Destination"] == "/var/lib/postgresql"]
        if len(data) != 1 or data[0].get("Type") != "volume" or data[0].get("Name") != config["project"] + "_db_data":
            raise OperationError("専用DBの保存領域を確認できません。")
    return item


def secret(config, role):
    name = "db_" + role + "_password"
    path = secure_path(Path(config["state"]) / "secrets" / name, owner=1000)
    value = path.read_bytes().strip()
    if not 32 <= len(value) <= 4096 or not re.fullmatch(b"[A-Za-z0-9_-]+", value):
        raise OperationError("DB秘密ファイルの形式を確認してください。")
    return value


def sql(config, query):
    item = container(config, "db")
    return run(ENGINE + ["exec", "-i", item["Id"], "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "mame_owner", "-d", "mame"], data=query.encode("utf-8"))


def client(config, role, program, arguments, data=b""):
    item = container(config, "db")
    # 資格はstdinからプロセス内環境へ渡す。Docker引数、psql引数、例外には含めない。
    # loopbackは初期化時のtrust設定に一致し得るため、認証される専用ネットワーク側の名前を使う。
    command = "IFS= read -r PGPASSWORD; export PGPASSWORD; exec " + program + " -h db -U mame_" + role + " -d mame " + " ".join(arguments)
    return run(ENGINE + ["exec", "-i", item["Id"], "sh", "-ceu", command], data=secret(config, role) + b"\n" + data, timeout=300)


def roles(config):
    commands = ["SET log_statement = 'none'; SET log_min_error_statement = 'panic'; BEGIN;"]
    for role in ("backup", "maintenance"):
        password = secret(config, role).decode("ascii")
        commands.append("DO $role$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mame_" + role + "') THEN CREATE ROLE mame_" + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '" + password + "'; END IF; END $role$;")
    commands.append("GRANT CONNECT ON DATABASE mame TO mame_backup, mame_maintenance; GRANT USAGE ON SCHEMA public TO mame_backup, mame_maintenance; GRANT SELECT ON ALL TABLES IN SCHEMA public TO mame_backup, mame_maintenance; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mame_backup; ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT ON TABLES TO mame_backup, mame_maintenance; ALTER DEFAULT PRIVILEGES FOR ROLE mame_migrate IN SCHEMA public GRANT SELECT ON SEQUENCES TO mame_backup; COMMIT;")
    sql(config, "\n".join(commands))
    client(config, "backup", "psql", ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"], b"SELECT 1;\n")
    # バックアップ資格に変更・DDL・管理権限が混入していれば、保管を始めずに止める。
    check = sql(config, "SELECT EXISTS (SELECT FROM pg_roles WHERE rolname='mame_backup' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND (has_table_privilege('mame_backup',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) OR has_schema_privilege('mame_backup','public','CREATE');")
    if check.strip() != b"f":
        raise OperationError("バックアップ用DB資格に読取以外の権限があります。")


def schema_version(config):
    directory, _ = source(config)
    exists = sql(config, "SELECT to_regclass('public.\"SchemaMigration\"') IS NOT NULL;").strip()
    if exists == b"f":
        count = sql(config, "SELECT count(*) FROM pg_tables WHERE schemaname='public';").strip()
        if count != b"0":
            raise OperationError("移行台帳のない既存DBがあります。空の復元先として扱いません。")
        return 0
    rows = json.loads(sql(config, 'SELECT COALESCE(json_agg(row ORDER BY name),\'[]\'::json) FROM (SELECT name,checksum FROM "SchemaMigration") row;'))
    names = sorted((directory / "apps/api/prisma/migrations").iterdir())
    expected = [{"name": path.name, "checksum": digest((path / "migration.sql").read_bytes().removeprefix(b"\xef\xbb\xbf"))} for path in names]
    if len(rows) not in (5, 6) or rows != expected[:len(rows)]:
        raise OperationError("対応する5世代または6世代のDB移行と一致しません。公開を停止したまま確認してください。")
    return len(rows)


def fingerprints(config):
    tables = json.loads(sql(config, "SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public';"))
    result = {}
    for table in tables:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]+", table):
            raise OperationError("復元対象の表名を確認できません。")
        query = "SELECT json_build_object('count',count(*),'sha256',encode(sha256(convert_to(COALESCE(string_agg(row::text,E'\\n' ORDER BY row::text COLLATE \"C\"),''),'UTF8')),'hex')) FROM (SELECT to_jsonb(t) row FROM public.\"" + table + "\" t) q;"
        result[table] = json.loads(sql(config, query))
    return result


def bind_bootstrap(config, deployment_id):
    uuid.UUID(deployment_id)
    # M05には削除台帳がなかったことを世代5のバックアップで明示し、初回移行だけ識別子を結び付ける。
    sql(config, "BEGIN; LOCK TABLE \"PrivacyState\",\"DeletionInstruction\" IN ACCESS EXCLUSIVE MODE; DO $bind$ BEGIN IF EXISTS (SELECT FROM \"DeletionInstruction\") OR (SELECT generation FROM \"PrivacyState\" WHERE id=1)<>0 THEN RAISE EXCEPTION 'binding refused'; END IF; END $bind$; UPDATE \"PrivacyState\" SET \"deploymentId\"='" + deployment_id + "'::uuid WHERE id=1; COMMIT;")


def journal(config, name, initial=None):
    path = Path(config["state"]) / (name + ".json")
    if path.exists():
        value = json.loads(secure_path(path).read_bytes())
        if value.get("release") != config["release"] or value.get("project") != config["project"]:
            if value.get("completed") and value.get("project") == config["project"]:
                archived = path.with_name(name + "-" + digest(canonical(value)) + ".json")
                if archived.exists():
                    if secure_path(archived).read_bytes() != canonical(value):
                        raise OperationError("以前の完了記録が一致しません。")
                    path.unlink()
                else:
                    path.rename(archived)
                value = dict(initial or {}, release=config["release"], project=config["project"])
                atomic(path, canonical(value))
            else:
                raise OperationError("途中の処理と設定が変わりました。設定を元に戻して再開してください。")
    else:
        value = dict(initial or {}, release=config["release"], project=config["project"])
        atomic(path, canonical(value))
    return path, value


def maintenance(config, mode, data=None):
    output = compose(config, "run", "--rm", "--no-deps", "-T", "maintenance", "node", "dist/privacy-maintenance.js", mode, data=data)
    try:
        return json.loads(output)
    except ValueError:
        raise OperationError("保守処理の結果を確認できません。公開を停止したまま確認してください。") from None


def ledger_sync(config):
    ledger = validate_ledger(maintenance(config, "export-ledger"))
    try:
        return _publish_ledger(config, ledger)
    except ErasureError:
        raise
    except (OperationError, ValueError, KeyError, TypeError):
        try:
            maintenance(config, "record-failure", canonical({"errorCode": "EXTERNAL_STORAGE_UNAVAILABLE"}))
        except OperationError:
            pass
        raise


def _publish_ledger(config, ledger):
    current = remote(config, "ledger-status", ledger["deploymentId"])
    latest = current["latest"]
    validate_prefix(ledger, latest)
    for pending in current["pending"]:
        validate_prefix(ledger, pending)
    if any(generation > ledger["generation"] for generation in current["orphanGenerations"]):
        raise OperationError("外部保管にこのDBにない未確定世代があります。削除を保留して確認してください。")
    plain = canonical(ledger)
    sha = digest(plain)
    if latest is None or latest["generation"] != ledger["generation"] or current["pending"] or current["orphanGenerations"]:
        ciphertext = encrypt(plain, config["ledgerPublicKey"])
        result = remote(config, "ledger-put", ledger["deploymentId"], expectedLatest=latest["plainSha256"] if latest else None,
                        metadata={"generation": ledger["generation"], "plainSha256": sha, "cipherSha256": digest(ciphertext), "keyFingerprint": fingerprint(config["ledgerPublicKey"])},
                        ciphertext=base64.b64encode(ciphertext).decode("ascii"))
        latest = result["latest"]
    confirmation = remote(config, "ledger-get", ledger["deploymentId"])
    if confirmation["latest"] != latest or latest["plainSha256"] != sha or digest(base64.b64decode(confirmation["ciphertext"], validate=True)) != latest["cipherSha256"]:
        raise OperationError("削除台帳の外部保管を確認できません。個人情報の削除は保留します。")
    try:
        maintenance(config, "apply-ledger", plain)
    except OperationError:
        try:
            maintenance(config, "record-failure", canonical({"errorCode": "ERASURE_FAILED"}))
        except OperationError:
            pass
        raise ErasureError("個人情報の削除処理が失敗しました。対象の記録を確認し、保守処理を再実行してください。") from None
    atomic(Path(config["state"]) / "ledger-receipt.json", canonical(dict(latest, deploymentId=ledger["deploymentId"])))
    return ledger, latest


def diagnose(config, *, installing=False):
    source(config)
    run(ENGINE + ["info", "--format", "{{.ServerVersion}}"])
    for name in SECRETS:
        path = secure_path(Path(config["state"]) / "secrets" / name, owner=1000)
        if not 32 <= path.stat().st_size <= 4096:
            raise OperationError("秘密ファイルの内容を表示せず、生成手順を確認してください。")
    if shutil.disk_usage(config["state"]).free < 2 * 1024**3:
        raise OperationError("空き容量が2GiB未満です。既存データを削除せず、容量を確保してください。")
    memory = Path("/proc/meminfo").read_text()
    available = re.search(r"^MemAvailable:\s+(\d+) kB", memory, re.M)
    if not available or int(available[1]) < 1024 * 1024:
        raise OperationError("利用可能メモリが1GiB未満です。既存サービスの余裕を確認してください。")
    if installing:
        check_port(config["port"])
        if container(config, "db", optional=True):
            raise OperationError("同じプロジェクトが存在します。新規導入ではなく更新手順を使ってください。")
        names = run(ENGINE + ["volume", "ls", "--format", "{{.Name}}"]).decode().splitlines()
        if config["project"] + "_db_data" in names:
            raise OperationError("この名前の既存DB保存領域があります。空の導入・復元先として扱いません。別の専用プロジェクト名を選んでください。")
    rendered = json.loads(compose(config, "config", "--format", "json"))
    for name in ("db", "api", "web", "migrate", "maintenance"):
        service = rendered["services"].get(name)
        if service and (service.get("ports") or service.get("privileged") or any("docker.sock" in str(item) for item in service.get("volumes", []))):
            raise OperationError("DB等の外部公開または不要な特権があります。")
    ports = rendered["services"]["proxy"].get("ports", [])
    if len(ports) != 1 or ports[0].get("host_ip") != "127.0.0.1" or str(ports[0].get("published")) != str(config["port"]):
        raise OperationError("プロキシの公開先は専用のloopbackポートに限定してください。")
    say("診断できました：配布物・Docker・秘密ファイル・空き容量・メモリ・公開ポート。")


def load_images(config):
    directory, manifest = source(config)
    run(ENGINE + ["load", "--input", str(directory.parent / "images.tar")], timeout=600)
    for image in manifest["images"].values():
        actual = json.loads(run(ENGINE + ["image", "inspect", image["reference"]]))[0]
        if actual["Id"] != image["id"]:
            raise OperationError("読み込んだイメージが配布物と一致しません。")


def backup(config, *, restart=True, bootstrap_id=None):
    version = schema_version(config)
    if version not in (5, 6):
        raise OperationError("バックアップ対象は確認済みのM05またはM06のDBに限定します。")
    roles(config)
    item = container(config, "api", optional=True)
    running = bool(item and item["State"]["Running"])
    if running:
        compose(config, "stop", "api")
    try:
        if version == 5:
            if not bootstrap_id:
                raise OperationError("M05からの初回更新ではupdateを実行し、台帳の初期結び付けを記録してください。")
            ledger = {"format": 1, "deploymentId": bootstrap_id, "generation": 0, "instructions": []}
            receipt = {"plainSha256": digest(canonical(ledger))}
        else:
            ledger, receipt = ledger_sync(config)
        data_fingerprints = fingerprints(config)
        dump = client(config, "backup", "pg_dump", ["--format=custom", "--no-owner"])
        if len(dump) > MAX_BACKUP:
            raise OperationError("バックアップがこの版の256MiB上限を超えました。公開手順の容量制限を確認してください。")
        _, manifest = source(config)
        timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        backup_id = "backup-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(6)
        payload = {"format": 1, "backupId": backup_id, "createdAt": timestamp, "version": manifest["version"], "deploymentId": ledger["deploymentId"],
                   "schemaVersion": version, "fingerprints": data_fingerprints,
                   "ledgerGeneration": ledger["generation"], "ledgerPlainSha256": receipt["plainSha256"], "dump": base64.b64encode(dump).decode("ascii"),
                   "secrets": {name: base64.b64encode((Path(config["state"]) / "secrets" / name).read_bytes()).decode("ascii") for name in SECRETS}}
        encrypted = encrypt(canonical(payload), config["backupPublicKey"])
        if len(encrypted) > MAX_BACKUP:
            raise OperationError("暗号化バックアップが256MiBの転送上限を超えました。")
        local = Path(config["state"]) / (backup_id + ".gpg")
        atomic(local, encrypted)
        result = remote(config, "backup-put", ledger["deploymentId"], backupId=backup_id, sha256=digest(encrypted), ciphertext=base64.b64encode(encrypted).decode("ascii"))
        check = remote(config, "backup-get", ledger["deploymentId"], backupId=backup_id)
        if result["sha256"] != digest(encrypted) or check["sha256"] != digest(encrypted) or digest(base64.b64decode(check["ciphertext"], validate=True)) != digest(encrypted):
            raise OperationError("暗号化バックアップの外部保管を確認できません。")
        atomic(Path(config["state"]) / "last-backup.json", canonical({"backupId": backup_id, "completedAt": timestamp, "sha256": digest(encrypted), "deploymentId": ledger["deploymentId"], "keyFingerprint": fingerprint(config["backupPublicKey"])}))
        remote(config, "backup-prune", ledger["deploymentId"], retentionDays=30)
        # ローカルと外部の両方へ同じ期間を適用する。削除台帳と復号鍵は消さない。
        cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
        for previous in Path(config["state"]).glob("backup-*.gpg"):
            if secure_path(previous).stat().st_mtime < cutoff:
                previous.unlink()
        if version == 6:
            maintenance(config, "record-backup", canonical({"completedAt": timestamp, "retentionDays": 30}))
        say("暗号化と別サーバーへの保管を確認しました。復元確認はrestore-checkで別途行ってください。保管ID：" + backup_id)
        return payload
    finally:
        if running and restart:
            # 失敗してもこの処理が止めた同じAPIだけを戻し、DBを消さない。
            current = container(config, "api")
            if current["Id"] == item["Id"] and current["Image"] == item["Image"]:
                compose(config, "start", "api")


def install(config):
    marker = Path(config["state"]) / "install.json"
    if not marker.exists():
        diagnose(config, installing=True)
    else:
        diagnose(config)
    marker, state = journal(config, "install")
    if state.get("completed"):
        say("この設定の導入は完了しています。diagnoseと画面で確認してください。")
        return
    load_images(config)
    say("1/3 専用DBを起動しています。既存サイトの設定には触れません。")
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--wait", "db")
    roles(config)
    say("2/3 データ構成を準備しています。")
    compose(config, "run", "--rm", "--no-deps", "-T", "migrate")
    ledger_sync(config)
    say("3/3 画面と受付を起動しています。")
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--wait", "api", "web", "proxy")
    state["completed"] = True
    atomic(marker, canonical(state))
    say("内部起動が完了しました。次に導入手順のHTTPS接続先を追加し、初期設定へ進んでください。")


def update(config):
    diagnose(config)
    if schema_version(config) not in (5, 6):
        raise OperationError("更新元のDBを確認できません。既存サービスは停止しません。")
    load_images(config)
    marker, state = journal(config, "update")
    if state.get("completed"):
        say("この更新は完了しています。diagnoseと画面で確認してください。")
        return
    say("1/4 受付を止め、更新前の暗号化バックアップを別サーバーへ保存します。")
    compose(config, "stop", "proxy", "api")
    if not state.get("backedUp"):
        if schema_version(config) == 5:
            state.setdefault("bootstrapId", str(uuid.uuid4()))
            atomic(marker, canonical(state))
        payload = backup(config, restart=False, bootstrap_id=state.get("bootstrapId"))
        state["backedUp"] = payload["backupId"]
        atomic(marker, canonical(state))
    # ここからの失敗では新旧が混在し得るため、古いアプリを自動で公開しない。
    say("2/4 固定イメージを確認します。")
    say("3/4 専用の移行資格でデータ構成を更新します。")
    compose(config, "run", "--rm", "--no-deps", "-T", "migrate")
    if state.get("bootstrapId") and not state.get("bound"):
        bind_bootstrap(config, state["bootstrapId"])
        state["bound"] = True
        atomic(marker, canonical(state))
    ledger_sync(config)
    say("4/4 更新した画面と受付を起動します。")
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--wait", "api", "web", "proxy")
    state["completed"] = True
    atomic(marker, canonical(state))
    say("更新しました。既存の管理者ログインと、受付のテストを実施してください。")


def rotate(config, role):
    if role not in ("app", "migrate", "backup", "maintenance"):
        raise OperationError("交換対象はapp、migrate、backup、maintenanceから選んでください。")
    # 更新・復元に必要な旧世代を残してから、対象のDB資格だけを交換する。
    path = Path(config["state"]) / "secrets" / ("db_" + role + "_password")
    pending = Path(config["state"]) / ("rotation-" + role + ".json")
    if not pending.exists():
        backup(config)
    compose(config, "stop", "proxy", "api")
    if pending.exists():
        item = json.loads(secure_path(pending).read_bytes())
        old, new = base64.b64decode(item["old"]), base64.b64decode(item["new"])
    else:
        old, new = secret(config, role), secrets.token_urlsafe(48).encode("ascii")
        atomic(pending, canonical({"old": base64.b64encode(old).decode(), "new": base64.b64encode(new).decode()}))
    sql(config, "SET log_statement='none'; SET log_min_error_statement='panic'; ALTER ROLE mame_" + role + " PASSWORD '" + new.decode("ascii") + "'; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='mame_" + role + "' AND pid<>pg_backend_pid();")
    atomic(path, new, owner=1000)
    client(config, role, "psql", ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"], b"SELECT 1;\n")
    item = container(config, "db")
    command = "IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -h db -U mame_" + role + " -d mame -X -q -c 'SELECT 1'"
    rejected = False
    try:
        run(ENGINE + ["exec", "-i", item["Id"], "sh", "-ceu", command], data=old + b"\n")
    except OperationError:
        rejected = True
    if not rejected:
        raise OperationError("旧資格の拒否を確認できません。受付を停止したまま確認してください。")
    pending.unlink()
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--force-recreate", "api", "proxy")
    say("対象のDB資格を交換し、新資格の接続と旧資格の拒否を確認しました。認証・バックアップの鍵は変更していません。")


def restore(config, arguments):
    # 復元先は新規プロジェクトだけ。既存ボリュームへ上書き復元しない。
    marker = Path(config["state"]) / "restore.json"
    diagnose(config, installing=not marker.exists())
    if marker.exists():
        _, previous = journal(config, "restore")
        if previous.get("backupId") != arguments.backup_id or previous.get("deploymentId") != arguments.deployment_id:
            raise OperationError("途中の復元と保管IDが変わりました。元の設定で再開してください。")
        compose(config, "stop", "proxy", "api")
    secure_path(arguments.backup_key)
    secure_path(arguments.ledger_key)
    response = remote(config, "backup-get", arguments.deployment_id, backupId=arguments.backup_id)
    encrypted = base64.b64decode(response["ciphertext"], validate=True)
    if digest(encrypted) != response["sha256"]:
        raise OperationError("復元するバックアップの指紋が一致しません。")
    payload = json.loads(decrypt(encrypted, arguments.backup_key))
    if payload.get("format") != 1 or payload.get("deploymentId") != arguments.deployment_id or payload.get("backupId") != arguments.backup_id:
        raise OperationError("復元するバックアップの識別情報が一致しません。")
    _, manifest = source(config)
    if payload["version"] != manifest["version"]:
        raise OperationError("先にバックアップと同じ版の配布物で復元してください。更新は復元確認の後に行います。")
    latest = remote(config, "ledger-get", arguments.deployment_id)
    if not latest["latest"] or latest["latest"]["generation"] < payload["ledgerGeneration"]:
        raise OperationError("最新の削除台帳を取得できません。公開は開始しません。")
    ledger = validate_ledger(json.loads(decrypt(base64.b64decode(latest["ciphertext"], validate=True), arguments.ledger_key)))
    if ledger["deploymentId"] != arguments.deployment_id or digest(canonical(ledger)) != latest["latest"]["plainSha256"] or ledger["generation"] != latest["latest"]["generation"]:
        raise OperationError("削除台帳の最新世代と暗号文が一致しません。公開は開始しません。")
    validate_prefix(dict(ledger, generation=payload["ledgerGeneration"], instructions=ledger["instructions"][:payload["ledgerGeneration"]]),
                    {"generation": payload["ledgerGeneration"], "plainSha256": payload["ledgerPlainSha256"]})
    marker, state = journal(config, "restore", {"backupId": arguments.backup_id, "deploymentId": arguments.deployment_id})
    if state.get("backupId") != arguments.backup_id or state.get("deploymentId") != arguments.deployment_id:
        raise OperationError("途中の復元と保管IDが変わりました。元の設定で再開してください。")
    load_images(config)
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--wait", "db")
    roles(config)
    if not state.get("restored"):
        existing = schema_version(config)
        if existing:
            # dumpがコミットされた直後に中断しても、全表の内容が一致する場合だけ先へ進む。
            if fingerprints(config) != payload["fingerprints"]:
                raise OperationError("復元途中のDBが元のバックアップと一致しません。公開を停止して確認してください。")
        else:
            dump = base64.b64decode(payload["dump"], validate=True)
            client(config, "migrate", "pg_restore", ["--exit-on-error", "--no-owner", "--clean", "--if-exists", "--single-transaction"], dump)
            if fingerprints(config) != payload["fingerprints"]:
                raise OperationError("復元前後の全表の内容が一致しません。")
        state["restored"] = True
        atomic(marker, canonical(state))
    if payload["schemaVersion"] == 5 and not state.get("bound"):
        compose(config, "run", "--rm", "--no-deps", "-T", "migrate")
        bind_bootstrap(config, payload["deploymentId"])
        state["bound"] = True
        atomic(marker, canonical(state))
    # 復元した指示へ最新台帳を重ね、古い資格の復活も一括で止める。
    maintenance(config, "restore-ledger", canonical(ledger))
    maintenance(config, "restore-security")
    confirmation = remote(config, "ledger-get", arguments.deployment_id)
    if confirmation["latest"] != latest["latest"]:
        raise OperationError("確認中に削除台帳が更新されました。公開せず、最新台帳の再適用を行ってください。")
    atomic(Path(config["state"]) / "restore-ready.json", canonical({"deploymentId": ledger["deploymentId"], "generation": ledger["generation"], "backupId": payload["backupId"], "checkedAt": datetime.now(timezone.utc).isoformat()}))
    say("隔離復元と削除台帳の再適用が完了しました。受付は停止中です。")
    say("次にpublish-restoreで公開を開始し、管理者の復旧・QR再発行・端末再承認を行ってから受付を再開してください。")


def publish_restore(config):
    # 再実行時も先に閉じる。外部照合に失敗したまま前回の公開を残さない。
    compose(config, "stop", "proxy", "api")
    ready = json.loads(secure_path(Path(config["state"]) / "restore-ready.json").read_bytes())
    ledger = validate_ledger(maintenance(config, "export-ledger"))
    latest = remote(config, "ledger-get", ready["deploymentId"])
    validate_prefix(ledger, latest["latest"])
    if not latest["latest"] or ledger["generation"] != latest["latest"]["generation"]:
        raise OperationError("最新台帳の再適用が必要です。公開は開始しません。")
    maintenance(config, "apply-ledger", canonical(ledger))
    confirmation = remote(config, "ledger-get", ready["deploymentId"])
    if confirmation["latest"] != latest["latest"]:
        raise OperationError("確認中に削除台帳が更新されました。復元検査を再実行するまで公開しません。")
    compose(config, "up", "-d", "--no-build", "--pull", "never", "--wait", "api", "web", "proxy")
    say("復元した環境を起動しました。管理者の復旧・受付端末の再承認・新しいQRでの受付確認が必要です。")


def enable_timer(config, config_path):
    directory, _ = source(config)
    command = ["/usr/bin/python3", str(directory / "scripts/operations.py"), "--config", str(config_path), "maintenance"]
    if any("\n" in item or '"' in item or "\\" in item or "%" in item for item in command):
        raise OperationError("自動実行のパスに使用できない文字があります。")
    name = config["project"] + "-maintenance"
    service = ("[Unit]\nDescription=入退出管理システムの保持・削除保守\nAfter=docker.service network-online.target\nRequires=docker.service\n"
               "[Service]\nType=oneshot\nUMask=0077\nExecStart=" + " ".join('"' + item + '"' for item in command) + "\n")
    timer = "[Unit]\nDescription=入退出管理システムの保守間隔\n[Timer]\nOnBootSec=2min\nOnCalendar=*-*-* *:0/5:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n"
    for suffix, value in (("service", service), ("timer", timer)):
        target = Path("/etc/systemd/system") / (name + "." + suffix)
        if target.exists() and target.read_text() != value:
            raise OperationError("同名の自動実行設定が存在します。上書きせず確認してください。")
        if not target.exists():
            atomic(target, value.encode("utf-8"))
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", name + ".timer"])
    say("5分ごとの削除保守と、1日1回の期限処理を有効にしました。処理結果は管理画面の保存・削除で確認できます。")
    backup_name = config["project"] + "-backup"
    backup_service = service.replace("保持・削除保守", "暗号化バックアップ").replace('"maintenance"', '"backup"') + "Restart=on-failure\nRestartSec=90\n"
    backup_timer = "[Unit]\nDescription=入退出管理システムの日次バックアップ\n[Timer]\nOnCalendar=*-*-* 03:30:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n"
    for suffix, value in (("service", backup_service), ("timer", backup_timer)):
        target = Path("/etc/systemd/system") / (backup_name + "." + suffix)
        if target.exists() and target.read_text() != value:
            raise OperationError("同名のバックアップ自動実行設定が存在します。上書きせず確認してください。")
        if not target.exists():
            atomic(target, value.encode("utf-8"))
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "--now", backup_name + ".timer"])
    say("毎日03:30（サーバーの時刻設定）に暗号化バックアップを取得し、別サーバーへ保存します。")


def main():
    parser = argparse.ArgumentParser(description="入退出管理システムのサーバー保守。秘密の値は引数へ指定しません。")
    parser.add_argument("--config", required=True, type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("configure", "diagnose", "install", "update", "backup", "maintenance", "publish-restore", "enable-maintenance"):
        sub.add_parser(name)
    rotation = sub.add_parser("rotate-db")
    rotation.add_argument("role", choices=("app", "migrate", "backup", "maintenance"))
    restoration = sub.add_parser("restore-check")
    restoration.add_argument("--deployment-id", required=True)
    restoration.add_argument("--backup-id", required=True)
    restoration.add_argument("--backup-key", required=True, type=Path)
    restoration.add_argument("--ledger-key", required=True, type=Path)
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or os.getuid() != 0:
            raise OperationError("このコマンドは対象Linuxサーバーのsudoで実行してください。")
        if args.command == "configure":
            configure(args.config)
            return
        config = load(args.config)
        with locked(Path(config["state"]) / "operations.lock"):
            if args.command == "diagnose":
                diagnose(config)
            elif args.command == "install":
                install(config)
            elif args.command == "update":
                update(config)
            elif args.command == "backup":
                backup(config)
            elif args.command == "maintenance":
                ledger_sync(config)
                marker = Path(config["state"]) / "retention-run.json"
                today = datetime.now(timezone.utc).date().isoformat()
                previous = json.loads(secure_path(marker).read_bytes()) if marker.exists() else {}
                result = {} if previous.get("date") == today else maintenance(config, "retention")
                atomic(marker, canonical({"date": today}))
                say("削除台帳の外部保管と保持処理が完了しました。未退室の記録は保持しています。")
                if not isinstance(result, dict):
                    raise OperationError("保持処理の結果を確認してください。")
            elif args.command == "rotate-db":
                rotate(config, args.role)
            elif args.command == "restore-check":
                restore(config, args)
            elif args.command == "publish-restore":
                publish_restore(config)
            elif args.command == "enable-maintenance":
                enable_timer(config, args.config)
    except OperationError as error:
        say(str(error))
        say("データ・鍵を削除せず、案内を確認してから再実行してください。更新・復元中なら公開を停止したまま確認します。")
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        # OS/DB/SSH例外の詳細にはパスや資格を含み得るため、固定案内だけを返す。
        say("処理を完了できませんでした。データ・鍵を削除せず、同じコマンドの手順と設定を確認してください。更新・復元中なら公開を停止したまま確認します。")
        sys.exit(1)


if __name__ == "__main__":
    main()
