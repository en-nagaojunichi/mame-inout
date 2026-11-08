#!/usr/bin/env python3
"""別ホストで暗号化世代を保管する。SSHの標準入力だけを受け付ける。"""

import base64
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


LIMIT = 256 * 1024 * 1024


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def atomic(path, data):
    descriptor, temporary = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def directory(path):
    # SSHアカウントだけが読める保管先を使い、Web公開領域との共用を避ける。
    if not path.is_absolute() or path != path.resolve() or path.is_symlink():
        raise ValueError()
    for parent in (path,) + tuple(path.parents):
        if parent.is_symlink():
            raise ValueError()
    value = path.stat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o700:
        raise ValueError()


def read(path):
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != os.getuid() or stat.S_IMODE(value.st_mode) != 0o600 or value.st_size > LIMIT:
        raise ValueError()
    return path.read_bytes()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", value):
        raise ValueError()
    return value


def operate(root, request):
    directory(root)
    identifier(request["deploymentId"])
    identifier(request["nonce"])
    destination = root / request["deploymentId"]
    if not destination.exists():
        destination.mkdir(mode=0o700)
    directory(destination)
    lock = os.open(destination / ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        lock_stat = os.fstat(lock)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink != 1 or lock_stat.st_uid != os.getuid() or stat.S_IMODE(lock_stat.st_mode) != 0o600:
            raise ValueError()
        fcntl.flock(lock, fcntl.LOCK_EX)
        latest_file = destination / "latest.json"
        latest = json.loads(read(latest_file)) if latest_file.exists() else None
        if latest and (set(latest) != {"generation", "plainSha256", "cipherSha256", "keyFingerprint", "file"} or
                       not re.fullmatch(r"ledger-\d+-[0-9a-f]{64}\.gpg", latest["file"])):
            raise ValueError()
        action = request["action"]
        if action in ("ledger-get", "ledger-status"):
            generations = [int(path.name.split("-")[1]) for path in destination.glob("ledger-*-*.gpg") if re.fullmatch(r"ledger-\d+-[0-9a-f]{64}\.gpg", path.name)]
            if action == "ledger-get" and generations and (not latest or max(generations) != latest["generation"]):
                # 最新ポインタだけ古く戻った場合も公開を止める。未確定世代は同じ保管処理で再試行する。
                raise ValueError()
            response = {"latest": latest}
            if latest:
                committed = destination / ("generation-" + str(latest["generation"]) + ".json")
                if not committed.exists() or json.loads(read(committed)) != latest:
                    raise ValueError()
            if action == "ledger-status":
                response["pending"] = []
                response["orphanGenerations"] = []
                for generation in sorted(set(generations)):
                    if latest and generation <= latest["generation"]:
                        continue
                    metadata_file = destination / ("generation-" + str(generation) + ".json")
                    if metadata_file.exists():
                        entry = json.loads(read(metadata_file))
                        if entry["generation"] != generation:
                            raise ValueError()
                        response["pending"].append(entry)
                    else:
                        response["orphanGenerations"].append(generation)
            if latest:
                ciphertext = read(destination / latest["file"])
                if hashlib.sha256(ciphertext).hexdigest() != latest["cipherSha256"]:
                    raise ValueError()
                response["ciphertext"] = base64.b64encode(ciphertext).decode("ascii")
        elif action == "ledger-put":
            metadata = request["metadata"]
            if set(metadata) != {"generation", "plainSha256", "cipherSha256", "keyFingerprint"}:
                raise ValueError()
            generation = metadata["generation"]
            if type(generation) is not int or generation < 0:
                raise ValueError()
            for key in ("plainSha256", "cipherSha256"):
                if not re.fullmatch(r"[0-9a-f]{64}", metadata[key]):
                    raise ValueError()
            if not re.fullmatch(r"[A-F0-9]{40,64}", metadata["keyFingerprint"]):
                raise ValueError()
            ciphertext = base64.b64decode(request["ciphertext"], validate=True)
            if not ciphertext or len(ciphertext) > LIMIT or hashlib.sha256(ciphertext).hexdigest() != metadata["cipherSha256"]:
                raise ValueError()
            # 先に読んだ最新世代との比較交換で、同時処理や巻き戻ったDBによる上書きを拒む。
            previous = latest["plainSha256"] if latest else None
            if request["expectedLatest"] != previous:
                raise ValueError()
            if latest and (generation < latest["generation"] or generation == latest["generation"] and metadata["plainSha256"] != previous):
                raise ValueError()
            existing_generations = [int(path.name.split("-")[1]) for path in destination.glob("ledger-*-*.gpg") if re.fullmatch(r"ledger-\d+-[0-9a-f]{64}\.gpg", path.name)]
            if existing_generations and max(existing_generations) > generation:
                raise ValueError()
            if latest and generation == latest["generation"]:
                response = {"latest": latest}
            else:
                filename = "ledger-" + str(generation) + "-" + metadata["cipherSha256"] + ".gpg"
                generation_file = destination / ("generation-" + str(generation) + ".json")
                if generation_file.exists() and json.loads(read(generation_file))["plainSha256"] != metadata["plainSha256"]:
                    raise ValueError()
                target = destination / filename
                if target.exists():
                    if read(target) != ciphertext:
                        raise ValueError()
                else:
                    atomic(target, ciphertext)
                latest = dict(metadata, file=filename)
                atomic(generation_file, encode(latest))
                atomic(latest_file, encode(latest))
                response = {"latest": latest}
        elif action == "backup-put":
            filename = identifier(request["backupId"]) + ".gpg"
            ciphertext = base64.b64decode(request["ciphertext"], validate=True)
            digest = hashlib.sha256(ciphertext).hexdigest()
            if not ciphertext or len(ciphertext) > LIMIT or digest != request["sha256"]:
                raise ValueError()
            target = destination / filename
            if target.exists():
                if read(target) != ciphertext:
                    raise ValueError()
            else:
                atomic(target, ciphertext)
            metadata_path = destination / (identifier(request["backupId"]) + ".json")
            if not metadata_path.exists():
                atomic(metadata_path, encode({"createdAt": datetime.now(timezone.utc).isoformat(), "sha256": hashlib.sha256(ciphertext).hexdigest()}))
            elif json.loads(read(metadata_path))["sha256"] != hashlib.sha256(ciphertext).hexdigest():
                raise ValueError()
            response = {"sha256": hashlib.sha256(read(target)).hexdigest()}
        elif action == "backup-get":
            backup_id = identifier(request["backupId"])
            metadata_path = destination / (backup_id + ".json")
            if not metadata_path.exists():
                raise ValueError()
            metadata = json.loads(read(metadata_path))
            ciphertext = read(destination / (backup_id + ".gpg"))
            if metadata["sha256"] != hashlib.sha256(ciphertext).hexdigest():
                raise ValueError()
            response = {"ciphertext": base64.b64encode(ciphertext).decode("ascii"), "sha256": hashlib.sha256(ciphertext).hexdigest()}
        elif action == "check":
            response = {"ready": True}
        elif action == "backup-prune":
            days = request["retentionDays"]
            if type(days) is not int or not 1 <= days <= 3650:
                raise ValueError()
            boundary = datetime.now(timezone.utc) - timedelta(days=days)
            deleted = 0
            for metadata_path in destination.glob("backup-*.json"):
                identifier(metadata_path.stem)
                metadata = json.loads(read(metadata_path))
                created = datetime.fromisoformat(metadata["createdAt"])
                if created < boundary:
                    data_path = metadata_path.with_suffix(".gpg")
                    if data_path.exists():
                        if hashlib.sha256(read(data_path)).hexdigest() != metadata["sha256"]:
                            raise ValueError()
                        data_path.unlink()
                    metadata_path.unlink()
                    deleted += 1
            for data_path in destination.glob("backup-*.gpg"):
                identifier(data_path.stem)
                if not data_path.with_suffix(".json").exists() and data_path.stat().st_mtime < boundary.timestamp():
                    # 保管途中で中断した暗号文も、保持期間を過ぎたら残し続けない。
                    read(data_path)
                    data_path.unlink()
                    deleted += 1
            response = {"deleted": deleted, "retentionDays": days}
        else:
            raise ValueError()
        machine = Path("/etc/machine-id").read_bytes().strip()
        if not machine:
            raise ValueError()
        return dict(response, nonce=request["nonce"], deploymentId=request["deploymentId"], hostId=hashlib.sha256(machine).hexdigest())
    finally:
        os.close(lock)


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError()
        raw = sys.stdin.buffer.read(LIMIT * 2 + 1)
        if len(raw) > LIMIT * 2:
            raise ValueError()
        result = operate(Path(sys.argv[1]), json.loads(raw))
        sys.stdout.buffer.write(encode(result))
    except (OSError, ValueError, KeyError, TypeError):
        sys.stderr.write("外部保管を完了できません。接続先・世代・権限を確認してください。\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
