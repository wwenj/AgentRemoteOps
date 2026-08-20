#!/usr/bin/env python3
"""Dependency-free Agent RemoteOps Protocol v2 client bundled with the Codex Skill."""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PROTOCOL_VERSION = 2
DEFAULT_TIMEOUT_SECONDS = 30
TERMINAL_JOB_STATES = {"succeeded", "failed", "cancelled", "timed_out"}
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SYSTEM_CA_FILES = (
    "/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
)


class ClientError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class Session:
    id: str
    url: str
    token: str
    client_id: str
    expires_at: str
    server_version: str
    protocol_version: int
    mode: str
    working_directory: str
    locale: str

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "Session":
        return cls(
            id=str(value["id"]), url=str(value["url"]), token=str(value["token"]),
            client_id=str(value["client_id"]), expires_at=str(value["expires_at"]),
            server_version=str(value["server_version"]), protocol_version=int(value["protocol_version"]),
            mode=str(value["mode"]), working_directory=str(value["working_directory"]),
            locale=str(value.get("locale", "zh-CN")),
        )


def _runtime_root() -> Path:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime:
        return Path(runtime) / "agent-remoteops-skill"
    uid = os.getuid() if hasattr(os, "getuid") else os.getpid()
    return Path(tempfile.gettempdir()) / f"agent-remoteops-skill-{uid}"


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


class SessionStore:
    def __init__(self, root: Path | None = None):
        self.root = root or _runtime_root()
        self.sessions = self.root / "sessions"
        self.current_file = self.root / "current"

    def save(self, session: Session) -> None:
        if not SESSION_ID_PATTERN.fullmatch(session.id):
            raise ClientError("INVALID_SESSION", "Remote service returned an invalid Session ID")
        self.sessions.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        os.chmod(self.sessions, 0o700)
        _atomic_json(self.sessions / f"{session.id}.json", asdict(session))
        _atomic_json(self.current_file, {"id": session.id})

    def load(self, session_id: str | None = None) -> Session:
        self.prune()
        target = session_id or self._current_id()
        if not target or not SESSION_ID_PATTERN.fullmatch(target):
            raise ClientError("SESSION_NOT_CONNECTED", "No active Agent RemoteOps Session")
        path = self.sessions / f"{target}.json"
        try:
            session = Session.from_json(json.loads(path.read_text(encoding="utf-8")))
        except FileNotFoundError as error:
            raise ClientError("SESSION_NOT_CONNECTED", "Agent RemoteOps Session is not connected") from error
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            self.remove(target)
            raise ClientError("INVALID_SESSION_STATE", "Local Session state is invalid") from error
        if _parse_time(session.expires_at) <= datetime.now(timezone.utc):
            self.remove(target)
            raise ClientError("SESSION_EXPIRED", "Agent RemoteOps Session has expired")
        return session

    def remove(self, session_id: str | None = None) -> None:
        target = session_id or self._current_id()
        if target and SESSION_ID_PATTERN.fullmatch(target):
            (self.sessions / f"{target}.json").unlink(missing_ok=True)
        if self._current_id() == target:
            remaining = sorted(self.sessions.glob("*.json")) if self.sessions.exists() else []
            if remaining:
                _atomic_json(self.current_file, {"id": remaining[0].stem})
            else:
                self.current_file.unlink(missing_ok=True)

    def prune(self) -> None:
        if not self.sessions.exists():
            return
        now = datetime.now(timezone.utc)
        for path in self.sessions.glob("*.json"):
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
                if _parse_time(str(value["expires_at"])) <= now:
                    path.unlink(missing_ok=True)
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
        current = self._current_id()
        if current and not (self.sessions / f"{current}.json").exists():
            remaining = sorted(self.sessions.glob("*.json"))
            if remaining:
                _atomic_json(self.current_file, {"id": remaining[0].stem})
            else:
                self.current_file.unlink(missing_ok=True)

    def _current_id(self) -> str | None:
        try:
            value = json.loads(self.current_file.read_text(encoding="utf-8"))
            return str(value["id"])
        except (OSError, KeyError, TypeError, json.JSONDecodeError):
            return None


def _normalize_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ClientError("INVALID_URL", "Connection URL must be an HTTP(S) URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ClientError("INVALID_URL", "Connection URL must not contain credentials, query, or fragment")
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _decode_response(response: Any) -> dict[str, Any]:
    raw = response.read().decode("utf-8", errors="replace")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ClientError("INVALID_RESPONSE", "Remote service returned a non-JSON response", response.status) from error
    if not isinstance(value, dict):
        raise ClientError("INVALID_RESPONSE", "Remote service returned an invalid JSON response", response.status)
    return value


def _ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    defaults = ssl.get_default_verify_paths()
    default_available = bool((defaults.cafile and Path(defaults.cafile).is_file()) or (defaults.capath and Path(defaults.capath).is_dir()))
    if not default_available:
        for candidate in SYSTEM_CA_FILES:
            if Path(candidate).is_file():
                context.load_verify_locations(cafile=candidate)
                break
    return context


def request(session: Session, method: str, path: str, body: dict[str, Any] | None = None, *, idempotent_mutation: bool = False) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {session.token}",
        "X-Agent-RemoteOps-Client-Id": session.client_id,
        "X-Agent-RemoteOps-Protocol": str(PROTOCOL_VERSION),
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if idempotent_mutation:
        headers["Idempotency-Key"] = str(uuid.uuid4())
    req = urllib.request.Request(f"{session.url}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT_SECONDS, context=_ssl_context()) as response:
            return _decode_response(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8", errors="replace"))
            remote_error = payload.get("error", {}) if isinstance(payload, dict) else {}
            code = str(remote_error.get("code") or "HTTP_ERROR")
            message = str(remote_error.get("message") or f"Remote service returned HTTP {error.code}")
        except (json.JSONDecodeError, AttributeError):
            code = "HTTP_ERROR"
            message = f"Remote service returned HTTP {error.code}"
        raise ClientError(code, message, error.code) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        detail = error.reason if isinstance(error, urllib.error.URLError) else error
        raise ClientError("NETWORK_ERROR", f"Unable to reach remote service: {detail}") from error


def _session_request(store: SessionStore, session: Session, method: str, path: str, body: dict[str, Any] | None = None, *, idempotent_mutation: bool = False) -> dict[str, Any]:
    try:
        return request(session, method, path, body, idempotent_mutation=idempotent_mutation)
    except ClientError as error:
        if error.code in {"UNAUTHORIZED", "CLIENT_ID_NOT_ALLOWED", "PROTOCOL_VERSION_UNSUPPORTED"}:
            store.remove(session.id)
        raise


def connect_session(url: str, token: str, store: SessionStore) -> dict[str, Any]:
    normalized = _normalize_url(url)
    candidate = Session(
        id="pending", url=normalized, token=token, client_id=str(uuid.uuid4()),
        expires_at="9999-12-31T23:59:59+00:00", server_version="unknown",
        protocol_version=PROTOCOL_VERSION, mode="unknown", working_directory=".", locale="zh-CN",
    )
    info = request(candidate, "GET", "/v2/session")
    if info.get("protocolVersion") != PROTOCOL_VERSION:
        raise ClientError("PROTOCOL_VERSION_UNSUPPORTED", f"Remote service does not support Protocol {PROTOCOL_VERSION}")
    session_id = str(info.get("id", ""))
    if not SESSION_ID_PATTERN.fullmatch(session_id):
        raise ClientError("INVALID_RESPONSE", "Remote service returned an invalid Session ID")
    session = Session(
        id=session_id, url=normalized, token=token, client_id=candidate.client_id,
        expires_at=str(info["expiresAt"]), server_version=str(info["serverVersion"]),
        protocol_version=int(info["protocolVersion"]), mode=str(info["mode"]),
        working_directory=str(info["workingDirectory"]), locale=str(info.get("locale", "zh-CN")),
    )
    if _parse_time(session.expires_at) <= datetime.now(timezone.utc):
        raise ClientError("SESSION_EXPIRED", "Agent RemoteOps Session has expired")
    store.save(session)
    return _public_session(info)


def _public_session(value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"id", "serverVersion", "protocolVersion", "locale", "mode", "workingDirectory", "expiresAt", "capabilities"}
    return {key: item for key, item in value.items() if key in allowed}


def _write_json(value: Any, stream: Any = sys.stdout) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")


def _session_option(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--session", help="Remote Session ID; defaults to the current Session")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Internal Agent RemoteOps Skill client")
    commands = parser.add_subparsers(dest="command", required=True)
    connect = commands.add_parser("connect")
    connect.add_argument("url")
    for name in ("status", "jobs", "disconnect"):
        command = commands.add_parser(name)
        _session_option(command)
    execute = commands.add_parser("exec")
    execute.add_argument("remote_command")
    execute.add_argument("--cwd", default=".")
    execute.add_argument("--timeout", type=int, default=60_000)
    execute.add_argument("--json", action="store_true")
    _session_option(execute)
    cancel = commands.add_parser("cancel")
    cancel.add_argument("job_id")
    _session_option(cancel)
    for name in ("list", "stat"):
        command = commands.add_parser(name)
        command.add_argument("remote_path")
        _session_option(command)
    read = commands.add_parser("read")
    read.add_argument("remote_path")
    read.add_argument("--out")
    _session_option(read)
    write = commands.add_parser("write")
    write.add_argument("local_path")
    write.add_argument("remote_path")
    write.add_argument("--if-match")
    _session_option(write)
    return parser


def run(args: argparse.Namespace, store: SessionStore | None = None, token_reader: Callable[[str], str] | None = None) -> int:
    store = store or SessionStore()
    if args.command == "connect":
        if not sys.stdin.isatty():
            raise ClientError("TTY_REQUIRED", "Token input requires an interactive TTY")
        token = (token_reader or getpass.getpass)("Token: ")
        if not token:
            raise ClientError("TOKEN_REQUIRED", "Token is required")
        _write_json(connect_session(args.url, token, store))
        return 0
    if args.command == "disconnect":
        store.remove(args.session)
        _write_json({"disconnected": True})
        return 0

    session = store.load(args.session)
    if args.command == "status":
        _write_json(_public_session(_session_request(store, session, "GET", "/v2/session")))
        return 0
    if args.command == "jobs":
        _write_json(_session_request(store, session, "GET", "/v2/jobs"))
        return 0
    if args.command == "cancel":
        _write_json(_session_request(store, session, "POST", f"/v2/jobs/{urllib.parse.quote(args.job_id, safe='')}/cancel"))
        return 0
    if args.command in {"list", "stat"}:
        _write_json(_session_request(store, session, "POST", f"/v2/fs/{args.command}", {"path": args.remote_path}))
        return 0
    if args.command == "read":
        result = _session_request(store, session, "POST", "/v2/fs/read", {"path": args.remote_path})
        content = base64.b64decode(str(result["content"]), validate=True)
        if args.out:
            Path(args.out).write_bytes(content)
            _write_json({"path": args.out, "size": result["size"], "sha256": result["sha256"]})
        else:
            sys.stdout.buffer.write(content)
            sys.stdout.buffer.flush()
        return 0
    if args.command == "write":
        content = Path(args.local_path).read_bytes()
        body = {"path": args.remote_path, "content": base64.b64encode(content).decode("ascii"), "encoding": "base64"}
        if args.if_match:
            body["ifMatch"] = args.if_match
        _write_json(_session_request(store, session, "POST", "/v2/fs/write", body, idempotent_mutation=True))
        return 0
    if args.command == "exec":
        created = _session_request(store, session, "POST", "/v2/jobs", {
            "command": args.remote_command, "cwd": args.cwd, "timeoutMs": args.timeout,
        }, idempotent_mutation=True)
        cursor = 0
        captured: list[dict[str, Any]] = []
        while True:
            job_id = urllib.parse.quote(str(created["jobId"]), safe="")
            job = _session_request(store, session, "GET", f"/v2/jobs/{job_id}?cursor={cursor}")
            for chunk in job.get("chunks", []):
                cursor = max(cursor, int(chunk["cursor"]))
                if args.json:
                    captured.append(chunk)
                else:
                    target = sys.stderr if chunk.get("stream") == "stderr" else sys.stdout
                    target.write(str(chunk.get("data", "")))
                    target.flush()
            if job.get("status") in TERMINAL_JOB_STATES:
                if args.json:
                    _write_json({"jobId": created["jobId"], **job, "chunks": captured})
                elif job.get("truncated"):
                    sys.stderr.write("\n[remote output truncated]\n")
                status = str(job.get("status"))
                if status == "succeeded":
                    return 0
                if status == "timed_out":
                    return 124
                if status == "cancelled":
                    return 130
                code = job.get("exitCode")
                return int(code) if isinstance(code, int) and 0 < code < 126 else 1
            time.sleep(0.4)
    raise ClientError("INVALID_COMMAND", "Unsupported Skill client command")


def main() -> int:
    if sys.version_info < (3, 10):
        _write_json({"error": {"code": "PYTHON_VERSION_UNSUPPORTED", "message": "Python 3.10 or later is required"}}, sys.stderr)
        return 2
    try:
        return run(build_parser().parse_args())
    except ClientError as error:
        details = {"code": error.code, "message": str(error)}
        if error.status:
            details["status"] = error.status
        _write_json({"error": details}, sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, base64.binascii.Error) as error:
        _write_json({"error": {"code": "LOCAL_ERROR", "message": str(error)}}, sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
