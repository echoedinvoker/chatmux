#!/usr/bin/env python3
"""Minimal Python adapter spike — validates stdio JSON-RPC handshake with AdapterRunner."""

import json
import sys

sys.stdout.reconfigure(line_buffering=True)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")


def respond(req_id, result):
    send({"jsonrpc": "2.0", "id": req_id, "result": result})


def notify(method, params):
    send({"jsonrpc": "2.0", "method": method, "params": params})


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue

    method = msg.get("method")
    req_id = msg.get("id")

    if method == "initialize":
        respond(req_id, {
            "platform": "python-spike",
            "supported_events": ["message"],
            "can_send": False,
            "can_backfill": False,
        })
        notify("event", {
            "type": "message",
            "chat": {"platform_id": "spike:1", "type": "direct", "name": "Spike Test"},
            "sender": {"platform_id": "spike:user1", "display_name": "測試用戶"},
            "content": {"type": "text", "text": "Hello from Python spike! 中文測試"},
            "platform_message_id": "spike-msg-1",
            "timestamp": 1700000000000,
        })
    elif method == "shutdown":
        respond(req_id, {})
        sys.exit(0)
    else:
        respond(req_id, {})
