from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "scripts" / "remoteops.py"
SPEC = importlib.util.spec_from_file_location("remoteops_skill_client", SCRIPT)
assert SPEC and SPEC.loader
remoteops = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = remoteops
SPEC.loader.exec_module(remoteops)


def future(minutes: int = 5) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat()


def session(session_id: str, token: str = "secret-token"):
    return remoteops.Session(
        id=session_id,
        url="http://127.0.0.1:1",
        token=token,
        client_id="11111111-1111-4111-8111-111111111111",
        expires_at=future(),
        server_version="0.3.0",
        protocol_version=2,
        mode="readonly",
        working_directory="/srv/app",
        locale="zh-CN",
    )


class SessionHandler(BaseHTTPRequestHandler):
    received_headers = None
    response_protocol = 2

    def do_GET(self):
        type(self).received_headers = self.headers
        if self.path != "/v2/session":
            self.send_error(404)
            return
        payload = {
            "id": "session-test",
            "serverVersion": "0.3.0",
            "protocolVersion": type(self).response_protocol,
            "locale": "zh-CN",
            "mode": "readonly",
            "workingDirectory": "/srv/app",
            "expiresAt": future(),
            "capabilities": ["fs.read", "exec.readonly"],
        }
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class HtmlErrorHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = b"<!doctype html><title>bad gateway</title>"
        self.send_response(502)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


class Server:
    def __init__(self, handler):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        host, port = self.server.server_address
        return f"http://{host}:{port}"

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class RemoteOpsClientTests(unittest.TestCase):
    def test_ssl_context_loads_trusted_ca_certificates(self):
        self.assertGreater(remoteops._ssl_context().cert_store_stats()["x509_ca"], 0)

    def test_session_store_permissions_multiple_sessions_and_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            store = remoteops.SessionStore(Path(directory) / "state")
            first = session("first")
            second = session("second")
            store.save(first)
            store.save(second)
            self.assertEqual(store.load().id, "second")
            self.assertEqual(store.load("first").id, "first")
            self.assertEqual(stat.S_IMODE(store.root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((store.sessions / "first.json").stat().st_mode), 0o600)
            expired = remoteops.Session(**{**remoteops.asdict(first), "id": "expired", "expires_at": "2000-01-01T00:00:00+00:00"})
            store.save(expired)
            with self.assertRaisesRegex(remoteops.ClientError, "not connected"):
                store.load("expired")
            self.assertFalse((store.sessions / "expired.json").exists())

    def test_connect_sends_v2_headers_and_never_persists_elsewhere(self):
        SessionHandler.received_headers = None
        SessionHandler.response_protocol = 2
        with tempfile.TemporaryDirectory() as directory, Server(SessionHandler) as url:
            store = remoteops.SessionStore(Path(directory) / "state")
            info = remoteops.connect_session(url, "secret-token", store)
            self.assertEqual(info["protocolVersion"], 2)
            self.assertEqual(SessionHandler.received_headers["Authorization"], "Bearer secret-token")
            self.assertEqual(SessionHandler.received_headers["X-Agent-RemoteOps-Protocol"], "2")
            self.assertEqual(store.load().token, "secret-token")
            self.assertNotIn("token", json.dumps(info).lower())

    def test_protocol_mismatch_is_not_saved(self):
        SessionHandler.response_protocol = 1
        with tempfile.TemporaryDirectory() as directory, Server(SessionHandler) as url:
            store = remoteops.SessionStore(Path(directory) / "state")
            with self.assertRaisesRegex(remoteops.ClientError, "Protocol 2"):
                remoteops.connect_session(url, "secret-token", store)
            self.assertFalse(store.current_file.exists())
        SessionHandler.response_protocol = 2

    def test_html_gateway_error_is_reported_without_response_body(self):
        with tempfile.TemporaryDirectory() as directory, Server(HtmlErrorHandler) as url:
            store = remoteops.SessionStore(Path(directory) / "state")
            with self.assertRaises(remoteops.ClientError) as raised:
                remoteops.connect_session(url, "secret-token", store)
            self.assertEqual(raised.exception.code, "HTTP_ERROR")
            self.assertNotIn("bad gateway", str(raised.exception).lower())
            self.assertNotIn("secret-token", str(raised.exception))

    def test_cli_rejects_non_tty_token_input_and_environment_token(self):
        environment = {**os.environ, "AGENT_REMOTEOPS_TOKEN": "must-not-be-used"}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "connect", "https://example.invalid"],
            input="secret-token\n",
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TTY_REQUIRED", result.stderr)
        self.assertNotIn("secret-token", result.stdout + result.stderr)
        self.assertNotIn("must-not-be-used", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
