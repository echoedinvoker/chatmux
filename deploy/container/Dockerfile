# Reference container for the chatmux daemon.
#
# Build context is the repo root, not this directory:
#   docker build -f deploy/container/Dockerfile -t chatmux .
#
# This image runs the daemon with **zero adapters** — no LINE, no Telegram. It exists
# to make the MCP server reachable from outside a container, which is the only part of
# chatmux that containerises cleanly. Adapters hold long-lived logged-in sessions and
# want a device slot each; putting those in a throwaway container is a different
# problem, deliberately out of scope here.
FROM oven/bun:1

WORKDIR /app

# Dependencies first so edits to src/ do not re-resolve the whole tree.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

# CHATMUX_MCP_HOST is the whole point of this image. The daemon defaults to 127.0.0.1,
# which inside a container means "reachable from this container only" — the port
# mapping would resolve to nothing. Binding the wildcard address is what makes the
# mapped port answer, and the daemon prints a loud warning when you do it.
#
# That warning is correct and you should read it: this listener has no authentication.
# Only publish the mapped port to a network you trust (see deploy/container/README.md).
ENV CHATMUX_DATA_DIR=/data \
    CHATMUX_MCP_HOST=0.0.0.0 \
    CHATMUX_MCP_PORT=7717

COPY deploy/container/entrypoint.sh /usr/local/bin/chatmux-entrypoint
RUN chmod +x /usr/local/bin/chatmux-entrypoint

EXPOSE 7717
ENTRYPOINT ["/usr/local/bin/chatmux-entrypoint"]
