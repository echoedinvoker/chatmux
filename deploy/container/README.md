# Running the chatmux daemon in a container

A reference container that serves the MCP endpoint to clients outside it.

```sh
docker compose -f deploy/container/compose.yml up --build
```

Then, from the host:

```sh
curl -sS -X POST http://127.0.0.1:7717/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18",
        "capabilities":{},
        "clientInfo":{"name":"curl","version":"0"}}}'
```

## Why this needs `CHATMUX_MCP_HOST`

The daemon binds `127.0.0.1` by default. Inside a container that means the container's
own loopback, so a published port maps to a socket nobody is listening on — the
container starts, the logs look healthy, and every connection is refused. The fix is
not a port mapping flag; it is binding an address the container's network interface
actually carries. That is what `CHATMUX_MCP_HOST=0.0.0.0` does, and it is the reason
this directory exists.

## What this image is not

**It runs zero adapters.** No LINE, no Telegram. Adapters own long-lived logged-in
sessions and consume a device slot per login; a container you rebuild is the wrong
home for that. Run adapters on the host and keep the container for the MCP surface,
or accept that logging in again per rebuild is on you.

**It is not an official image.** Nothing publishes it, nothing tests it in CI beyond
the fact that it built and answered once. Read it, then own it.

## The warning is not boilerplate

Binding anything other than loopback makes the daemon print this at startup:

```
[MCP] WARNING: bound to 0.0.0.0, which is not loopback. ...
```

It means what it says. The MCP listener has **no authentication** and none of the
file-permission protection the unix socket gets. Anyone who can reach the address can
read the full text of every conversation and send messages as you.

Inside a container, binding the wildcard is normal and fine — the container's network
is the boundary. The decision that matters is the **host** side of the port mapping,
which is why `compose.yml` publishes to `127.0.0.1:7717` rather than `0.0.0.0:7717`.
If you widen that, put a firewall or a private overlay (Tailscale, WireGuard, a
container network you do not publish) in front of it.

## Configuration

| Variable | Default here | Meaning |
|---|---|---|
| `CHATMUX_MCP_HOST` | `0.0.0.0` | Address the TCP listener binds. Daemon default is `127.0.0.1`. |
| `CHATMUX_MCP_PORT` | `7717` | TCP port. `0` disables TCP, leaving the unix socket. |
| `CHATMUX_DATA_DIR` | `/data` | Event log, SQLite database, `adapters.json`, unix socket. Back this volume up. |

`CHATMUX_MCP_HOST` also has a config-file equivalent, `mcp.host` in `adapters.json`;
the environment variable wins. Either way an invalid value is a startup error, never a
silent fall back to loopback — a bind host that quietly ignores you is how you spend an
afternoon debugging a port mapping that was never the problem.
