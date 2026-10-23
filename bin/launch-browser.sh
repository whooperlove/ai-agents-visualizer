#!/bin/sh
# Open the local observer in the system default browser without UI automation.
set -eu

VISUALIZER_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$VISUALIZER_SCRIPT_DIR/launch-messages.sh"
VISUALIZER_LANG=$(visualizer_lang)
case "${1-}" in
    --help|-h)
        visualizer_text help_browser "$VISUALIZER_SCRIPT_DIR"
        exit 0
        ;;
esac
if [ "$#" -ne 0 ]; then
    visualizer_text browser_no_options >&2
    exit 1
fi

exec /bin/sh "$VISUALIZER_SCRIPT_DIR/launch.sh" --browser
