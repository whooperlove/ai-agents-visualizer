#!/bin/sh
# Start the local observer, then open it in VS Code or the default browser.
set -eu

VISUALIZER_SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$VISUALIZER_SCRIPT_DIR/launch-messages.sh"
VISUALIZER_LANG=$(visualizer_lang)
# The Node launcher (and the server it starts) must speak the same language as this script.
WAS_LANG=$VISUALIZER_LANG
export WAS_LANG
VISUALIZER_SERVER_ONLY=false
VISUALIZER_DEFAULT_BROWSER=false

case "${1-}" in
    "") ;;
    --server-only) VISUALIZER_SERVER_ONLY=true ;;
    --browser) VISUALIZER_DEFAULT_BROWSER=true ;;
    --help|-h)
        visualizer_text help_main "$VISUALIZER_SCRIPT_DIR"
        exit 0
        ;;
    *) visualizer_text opt_unknown "$1" >&2; exit 1 ;;
esac
if [ "$#" -gt 1 ]; then
    visualizer_text opt_conflict >&2
    exit 1
fi

VISUALIZER_NODE=${AI_AGENTS_NODE_BIN-}
if [ -z "$VISUALIZER_NODE" ]; then
    VISUALIZER_NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$VISUALIZER_NODE" ]; then
    for VISUALIZER_CANDIDATE in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
        if [ -x "$VISUALIZER_CANDIDATE" ] && "$VISUALIZER_CANDIDATE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
            VISUALIZER_NODE=$VISUALIZER_CANDIDATE
            break
        fi
    done
fi
if [ -z "$VISUALIZER_NODE" ] || [ ! -x "$VISUALIZER_NODE" ]; then
    visualizer_text node_missing >&2
    exit 1
fi
if ! "$VISUALIZER_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    visualizer_text node_old >&2
    exit 1
fi

VISUALIZER_URL=$("$VISUALIZER_NODE" "$VISUALIZER_SCRIPT_DIR/launcher.js") || exit 1
case "$VISUALIZER_URL" in
    http://127.0.0.1:4317) ;;
    *) visualizer_text url_bad >&2; exit 1 ;;
esac
printf '%s\n' "$VISUALIZER_URL"
if [ "$VISUALIZER_SERVER_ONLY" = true ]; then
    exit 0
fi

if [ "$(uname -s)" != Darwin ]; then
    visualizer_text not_macos >&2
    visualizer_text open_manual "$VISUALIZER_URL" >&2
    exit 1
fi
if [ "$VISUALIZER_DEFAULT_BROWSER" = true ]; then
    VISUALIZER_OPEN=${AI_AGENTS_OPEN_BIN-/usr/bin/open}
    if [ ! -x "$VISUALIZER_OPEN" ]; then
        visualizer_text open_missing >&2
        visualizer_text open_manual "$VISUALIZER_URL" >&2
        exit 1
    fi
    if ! "$VISUALIZER_OPEN" "$VISUALIZER_URL"; then
        visualizer_text open_failed >&2
        visualizer_text open_manual "$VISUALIZER_URL" >&2
        exit 1
    fi
    visualizer_text open_sent
    exit 0
fi
VISUALIZER_OSASCRIPT=${AI_AGENTS_OSASCRIPT_BIN-/usr/bin/osascript}
if [ ! -x "$VISUALIZER_OSASCRIPT" ]; then
    visualizer_text osa_missing >&2
    exit 1
fi

# This user-run branch drives only the already-open Code application. It does not
# install extensions, change settings, change the clipboard, or launch another browser.
# The script text stays fixed; its error messages arrive as arguments 2 to 7 in the chosen language.
if ! "$VISUALIZER_OSASCRIPT" - "$VISUALIZER_URL" \
    "$(visualizer_text osa_no_code)" "$(visualizer_text osa_no_window)" \
    "$(visualizer_text osa_no_palette)" "$(visualizer_text osa_focus_search)" \
    "$(visualizer_text osa_no_urlfield)" "$(visualizer_text osa_focus_url)" <<'APPLESCRIPT'
on run argv
    set targetUrl to item 1 of argv
    set noCodeText to item 2 of argv
    set noWindowText to item 3 of argv
    set noPaletteText to item 4 of argv
    set searchFocusText to item 5 of argv
    set noUrlFieldText to item 6 of argv
    set urlFocusText to item 7 of argv
    tell application "System Events"
        set codeProcesses to every application process whose bundle identifier is "com.microsoft.VSCode"
        if (count of codeProcesses) is 0 then error noCodeText
        set codeProcess to item 1 of codeProcesses
        if (count of windows of codeProcess) is 0 then error noWindowText
    end tell
    tell application id "com.microsoft.VSCode" to activate
    tell application "System Events"
        tell codeProcess
            set frontmost to true
            delay 0.2
            key code 35 using {command down, shift down}
        end tell
        set paletteReady to false
        repeat 20 times
            try
                set focusedElement to value of attribute "AXFocusedUIElement" of codeProcess
                if role of focusedElement is "AXTextField" and description of focusedElement contains "Type the name of a command to run" then
                    if (value of focusedElement as text) starts with ">" then
                        set paletteReady to true
                        exit repeat
                    end if
                end if
            end try
            delay 0.1
        end repeat
        if not paletteReady then
            -- Electron can expose the selected quick-pick row as the focused AX
            -- element. Verify its command input in the same front window instead.
            try
                set paletteElements to entire contents of front window of codeProcess
                repeat with candidate in paletteElements
                    try
                        if role of candidate is "AXTextField" and description of candidate contains "Type the name of a command to run" then
                            if (value of candidate as text) starts with ">" then
                                set paletteReady to true
                                exit repeat
                            end if
                        end if
                    end try
                end repeat
            end try
        end if
        if not paletteReady then error noPaletteText
        if not frontmost of codeProcess then error searchFocusText
        tell codeProcess
            keystroke "Browser: Open Integrated Browser"
            delay 0.6
            key code 36
            delay 0.5
            key code 37 using {command down}
        end tell
        set urlFieldReady to false
        repeat 80 times
            try
                set focusedElement to value of attribute "AXFocusedUIElement" of codeProcess
                if role of focusedElement is "AXTextField" and description of focusedElement is "Search or enter URL" then
                    set urlFieldReady to true
                    exit repeat
                end if
            end try
            delay 0.1
        end repeat
        if not urlFieldReady then error noUrlFieldText
        if not frontmost of codeProcess then error urlFocusText
        tell codeProcess
            key code 0 using {command down}
            keystroke targetUrl
            key code 36
        end tell
    end tell
end run
APPLESCRIPT
then
    visualizer_text vscode_failed >&2
    visualizer_text vscode_a11y >&2
    visualizer_text vscode_manual "$VISUALIZER_URL" >&2
    visualizer_text vscode_browser "$VISUALIZER_SCRIPT_DIR" >&2
    exit 1
fi
visualizer_text vscode_sent
