#!/usr/bin/env bash
# Fetch the daemon's get_status over the local MCP HTTP endpoint and print the
# adapter block. Used by F27 to sample connection state around suspend/resume.
URL="${CHATMUX_MCP_URL:-http://127.0.0.1:7717/mcp}"
HDRS=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

SID=$(curl -s -D - -o /dev/null -X POST "$URL" "${HDRS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"f27","version":"1"}}}' \
  | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')

[ -z "$SID" ] && { echo "could not obtain MCP session id from $URL" >&2; exit 1; }

curl -s -X POST "$URL" "${HDRS[@]}" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

OUT=$(curl -s -X POST "$URL" "${HDRS[@]}" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_status","arguments":{}}}')

# Close the session. The daemon only drops it on transport close, so a polling
# caller that skips this slowly fills the session map of the process under test.
curl -s -X DELETE "$URL" "${HDRS[@]}" -H "mcp-session-id: $SID" >/dev/null

printf '%s' "$OUT" \
  | sed -n 's/^data: //p' \
  | python3 -c 'import json,sys
raw = sys.stdin.read().strip()
if not raw:
    print("no data frame in response"); sys.exit(1)
msg = json.loads(raw)
text = msg["result"]["content"][0]["text"]
data = json.loads(text)
print(json.dumps(data.get("adapters", data), indent=2, ensure_ascii=False))'
