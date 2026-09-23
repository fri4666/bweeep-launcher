#!/usr/bin/env python3
"""Loopback-only, one-use consumeGameTicket fixture for an isolated Forge test."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EXPECTED_TICKET = os.environ["BWEEP_MOCK_TICKET"]
EXPECTED_GAME_NAME = os.environ["BWEEP_MOCK_GAME_NAME"]
PORT = int(os.environ.get("BWEEP_MOCK_PORT", "39001"))
used = False


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global used
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length)) if 0 < length <= 512 else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        valid = (
            not used
            and self.path == "/launcher-access"
            and body.get("action") == "consumeGameTicket"
            and body.get("ticket") == EXPECTED_TICKET
            and body.get("gameName") == EXPECTED_GAME_NAME
        )
        if valid:
            used = True
            status = 200
            response = {
                "ok": True,
                "userId": "00000000-0000-4000-8000-000000000001",
                "discordId": "123456789012345",
                "role": "member",
            }
        else:
            status = 401
            response = {"ok": False}
        payload = json.dumps(response).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    if len(EXPECTED_TICKET) != 43:
        raise SystemExit("BWEEP_MOCK_TICKET must be a 43-character ticket")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Mock ticket endpoint ready on loopback port {PORT}", flush=True)
    server.serve_forever()
