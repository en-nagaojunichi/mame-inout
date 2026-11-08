"""導入・保管コマンドの共通検査。秘密値を例外や引数へ展開しない。"""

import base64
from contextlib import contextmanager
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import tempfile
import uuid


class OperationError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def file_digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            value.update(chunk)
    return value.hexdigest()


def run(arguments, *, data=None, timeout=180, env=None):
    try:
        return subprocess.run(arguments, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=True, timeout=timeout, env=env).stdout
    except (OSError, subprocess.SubprocessError):
        raise OperationError("処理を完了できません。対象サービスの状態と操作手順を確認してください。") from None


def secure_path(path, *, directory=False, owner=None):
    path = Path(path)
    if not path.is_absolute() or path != path.resolve():
        raise OperationError("保管先にはリンクを含まない絶対パスを指定してください。")
    for candidate in (path,) + tuple(path.parents):
        if candidate.is_symlink():
            raise OperationError("保管先にシンボリックリンクは使用できません。")
        if candidate.exists() and candidate != path:
            item = candidate.stat()
            if stat.S_IMODE(item.st_mode) & 0o022 and not (item.st_uid == 0 and item.st_mode & stat.S_ISVTX):
                raise OperationError("保管先の親フォルダーを第三者が書き換えられます。アクセス権を確認してください。")
    item = path.lstat()
    expected_owner = os.getuid() if owner is None else owner
    if item.st_uid != expected_owner or stat.S_IMODE(item.st_mode) != (0o700 if directory else 0o600):
        raise OperationError("専用の保管先と所有者・アクセス権を確認してください。")
    if not (stat.S_ISDIR(item.st_mode) if directory else stat.S_ISREG(item.st_mode) and item.st_nlink == 1):
        raise OperationError("保管先の種類またはリンク数が不正です。")
    return path


def atomic(path, data, *, owner=None):
    descriptor, temporary = tempfile.mkstemp(prefix=".incoming-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if owner is not None:
            os.chown(temporary, owner, owner)
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked(path):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        secure_path(path)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    except BlockingIOError:
        raise OperationError("別の保守処理が実行中です。終了後にもう一度実行してください。") from None
    finally:
        os.close(descriptor)


def validate_ledger(value):
    if not isinstance(value, dict) or set(value) != {"format", "deploymentId", "generation", "instructions"} or value["format"] != 1:
        raise OperationError("削除台帳の形式が不正です。公開を停止したまま確認してください。")
    uuid.UUID(value["deploymentId"])
    generation = value["generation"]
    entries = value["instructions"]
    if type(generation) is not int or generation < 0 or not isinstance(entries, list) or len(entries) != generation:
        raise OperationError("削除台帳の世代が連続していません。")
    operations, people = set(), set()
    for sequence, entry in enumerate(entries, 1):
        if set(entry) != {"sequence", "operationId", "personId", "requestedAt"} or entry["sequence"] != sequence:
            raise OperationError("削除台帳の指示が欠けています。")
        uuid.UUID(entry["operationId"])
        uuid.UUID(entry["personId"])
        if entry["operationId"] in operations or entry["personId"] in people or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", entry["requestedAt"]):
            raise OperationError("削除台帳の指示が重複しているか不正です。")
        operations.add(entry["operationId"])
        people.add(entry["personId"])
    return value


def validate_prefix(ledger, latest):
    validate_ledger(ledger)
    if latest is None:
        return
    count = latest["generation"]
    if type(count) is not int or count < 0 or count > ledger["generation"]:
        raise OperationError("外部台帳より古いDBです。削除処理を止め、復元手順で最新台帳を適用してください。")
    prefix = dict(ledger, generation=count, instructions=ledger["instructions"][:count])
    if digest(canonical(prefix)) != latest["plainSha256"]:
        raise OperationError("DBと外部台帳が一致しません。公開を停止し、最新台帳から復元してください。")


def remote(config, action, deployment_id, **payload):
    nonce = secrets.token_hex(24)
    request = dict(payload, action=action, deploymentId=deployment_id, nonce=nonce)
    host, root = config["externalHost"], config["externalRoot"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", host) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", root) or ".." in root.split("/"):
        raise OperationError("外部保管のSSH接続名または絶対パスが不正です。")
    result = json.loads(run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
                             host, "python3", "/usr/local/lib/mame-inout/operations-store.py", root], data=canonical(request), timeout=300))
    if result.pop("nonce", None) != nonce or result.pop("deploymentId", None) != deployment_id:
        raise OperationError("外部台帳の最新応答を確認できません。公開を停止したまま確認してください。")
    host_id = result.pop("hostId", None)
    local_id = digest(Path("/etc/machine-id").read_bytes().strip())
    if not isinstance(host_id, str) or not re.fullmatch(r"[0-9a-f]{64}", host_id) or host_id == local_id:
        raise OperationError("外部保管には、このサーバーと異なるホストを指定してください。")
    if config.get("externalHostId") and host_id != config["externalHostId"]:
        raise OperationError("外部保管先の識別情報が変わりました。管理者が確認するまで停止します。")
    result["hostId"] = host_id
    return result


def fingerprint(public_key):
    with tempfile.TemporaryDirectory(prefix="mame-show-key-") as temporary:
        packets = run(["gpg", "--batch", "--no-options", "--homedir", temporary, "--list-packets", str(public_key)])
        if b"secret key packet" in packets or b"secret sub key packet" in packets:
            raise OperationError("通常サーバーへ渡すのは公開鍵だけです。復号鍵を別の場所へ移してください。")
        output = run(["gpg", "--batch", "--no-options", "--homedir", temporary, "--with-colons", "--show-keys", str(public_key)])
    entries = [line.split(":")[9] for line in output.decode("utf-8").splitlines() if line.startswith("fpr:")]
    if not entries or not re.fullmatch(r"[A-F0-9]{40,64}", entries[0]):
        raise OperationError("暗号化用の公開鍵を確認してください。")
    return entries[0]


def encrypt(data, public_key):
    # 復号鍵は通常サーバーに置かず、暗号化用の公開鍵だけを使う。
    with tempfile.TemporaryDirectory(prefix="mame-gpg-") as temporary:
        os.chmod(temporary, 0o700)
        return run(["gpg", "--batch", "--no-options", "--homedir", temporary, "--trust-model", "always",
                    "--recipient-file", str(public_key), "--encrypt", "--output", "-"], data=data)


@contextmanager
def private_key_home():
    with tempfile.TemporaryDirectory(prefix="mame-restore-key-") as temporary:
        os.chmod(temporary, 0o700)
        try:
            yield temporary
        finally:
            # 復号後は鍵ファイルだけでなく、専用agentに残る鍵・パスフレーズのキャッシュも終了する。
            try:
                subprocess.run(["gpgconf", "--homedir", temporary, "--kill", "gpg-agent"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=True)
            except (OSError, subprocess.SubprocessError):
                raise OperationError("復号用agentの終了を確認できません。公開を停止したまま管理者が確認してください。") from None


def decrypt(data, private_key, *, passphrase_reader=None):
    secure_path(private_key)
    with private_key_home() as temporary:
        run(["gpg", "--batch", "--no-options", "--homedir", temporary, "--import", str(private_key)])
        try:
            return run(["gpg", "--batch", "--no-options", "--homedir", temporary, "--pinentry-mode", "error", "--decrypt"], data=data)
        except OperationError:
            if passphrase_reader is None and not os.isatty(0):
                raise OperationError("パスフレーズ付きの復号鍵は対話端末で使用してください。秘密の内容を引数へ書かないでください。") from None
            phrase = (passphrase_reader or getpass.getpass)("復号鍵のパスフレーズ: ")
            if len(phrase.encode("utf-8")) > 1024 or "\n" in phrase or "\r" in phrase or "\0" in phrase:
                raise OperationError("復号鍵のパスフレーズを確認してください。")
            read_descriptor, write_descriptor = os.pipe()
            try:
                os.write(write_descriptor, phrase.encode("utf-8") + b"\n")
                os.close(write_descriptor)
                write_descriptor = None
                arguments = ["gpg", "--batch", "--no-options", "--homedir", temporary, "--pinentry-mode", "loopback", "--passphrase-fd", str(read_descriptor), "--decrypt"]
                try:
                    return subprocess.run(arguments, input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                          check=True, timeout=180, pass_fds=(read_descriptor,)).stdout
                except (OSError, subprocess.SubprocessError):
                    raise OperationError("復号できません。対象世代の鍵とパスフレーズを確認してください。") from None
            finally:
                os.close(read_descriptor)
                if write_descriptor is not None:
                    os.close(write_descriptor)


def check_port(port):
    with socket.socket() as endpoint:
        try:
            endpoint.bind(("127.0.0.1", port))
        except OSError:
            raise OperationError("公開先の内部ポートが使用中です。既存サービスと異なるポートを選んでください。") from None
