#!/bin/sh
# Stop the local observer that launch.sh started. A process gets SIGTERM only when it answers
# /api/health as this application and is among the processes listening on its port.
# Exit status: 0 stopped or not running, 1 nothing stopped (reason on stderr).
set -eu

VISUALIZER_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$VISUALIZER_SCRIPT_DIR/launch-messages.sh"
VISUALIZER_LANG=$(visualizer_lang)
# The port launcher.js starts the server on.
VISUALIZER_PORT=4317
# The server closes its port within milliseconds; wait up to 50 x 0.2 seconds before giving up.
VISUALIZER_WAIT_STEPS=50

case "${1-}" in
    --help|-h)
        visualizer_text help_stop "$VISUALIZER_SCRIPT_DIR"
        exit 0
        ;;
esac
if [ "$#" -ne 0 ]; then
    visualizer_text stop_no_options >&2
    exit 1
fi

VISUALIZER_CURL=$(command -v curl 2>/dev/null || true)
if [ -z "$VISUALIZER_CURL" ]; then
    visualizer_text curl_missing >&2
    exit 1
fi
# lsof lives in /usr/sbin, which a minimal PATH may lack.
VISUALIZER_LSOF=$(command -v lsof 2>/dev/null || true)
if [ -z "$VISUALIZER_LSOF" ] && [ -x /usr/sbin/lsof ]; then
    VISUALIZER_LSOF=/usr/sbin/lsof
fi

# Prints the ids of the processes that listen on the port, one per line.
visualizer_listeners() {
    if [ -n "$VISUALIZER_LSOF" ]; then
        "$VISUALIZER_LSOF" -nP -t "-iTCP:$VISUALIZER_PORT" -sTCP:LISTEN 2>/dev/null || true
    fi
}

# Succeeds while process $VISUALIZER_PID still listens on the port.
visualizer_is_listening() {
    visualizer_listeners | grep -qx "$VISUALIZER_PID"
}

# curl exits with 7 when nothing accepts the connection: the server is not running.
VISUALIZER_CURL_STATUS=0
VISUALIZER_HEALTH=$("$VISUALIZER_CURL" -s --max-time 2 "http://127.0.0.1:$VISUALIZER_PORT/api/health") || VISUALIZER_CURL_STATUS=$?
case "$VISUALIZER_CURL_STATUS" in
    0) ;;
    7) visualizer_text not_running "$VISUALIZER_PORT"; exit 0 ;;
    *) visualizer_text health_failed "$VISUALIZER_PORT" >&2; exit 1 ;;
esac

# The same identity fields launcher.js requires before it reuses a server.
for VISUALIZER_FRAGMENT in '"app":"ai-agents-visualizer"' '"ok":true' '"readOnly":true' '"host":"127.0.0.1"'; do
    case "$VISUALIZER_HEALTH" in
        *"$VISUALIZER_FRAGMENT"*) ;;
        *) visualizer_text not_visualizer "$VISUALIZER_PORT" >&2; exit 1 ;;
    esac
done
VISUALIZER_PID=$(printf '%s\n' "$VISUALIZER_HEALTH" | sed -n 's/.*"processId":\([1-9][0-9]*\)[,}].*/\1/p')
case "$VISUALIZER_PID" in
    ''|*[!0-9]*) visualizer_text not_visualizer "$VISUALIZER_PORT" >&2; exit 1 ;;
esac

# The health answer only names a process; the listening socket proves it is the one on the port.
if ! visualizer_is_listening; then
    visualizer_text owner_unconfirmed "$VISUALIZER_PORT" >&2
    exit 1
fi

if ! kill -TERM "$VISUALIZER_PID" 2>/dev/null; then
    visualizer_text kill_failed "$VISUALIZER_PID" >&2
    exit 1
fi

VISUALIZER_WAITED=0
while visualizer_is_listening; do
    if [ "$VISUALIZER_WAITED" -ge "$VISUALIZER_WAIT_STEPS" ]; then
        visualizer_text stop_timeout "$VISUALIZER_PID" >&2
        exit 1
    fi
    sleep 0.2
    VISUALIZER_WAITED=$((VISUALIZER_WAITED + 1))
done
visualizer_text stopped "$VISUALIZER_PID"
