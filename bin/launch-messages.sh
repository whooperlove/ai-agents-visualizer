# Language selection and the user-visible messages of launch.sh and launch-browser.sh.
# Sourced with `.` by those scripts; never run directly. The scripts themselves hold no
# natural-language text: every message, English and Korean, lives in visualizer_text below.

# Prints ko or en. Same priority as the Node side (src/i18n.js): the first of WAS_LANG, LC_ALL,
# LC_MESSAGES and LANG whose value, without a .encoding suffix, is a Korean or an English locale
# wins. Anything else (C, POSIX, other languages, unset) is skipped; the default is English.
visualizer_lang() {
    for VISUALIZER_LANG_VALUE in "${WAS_LANG-}" "${LC_ALL-}" "${LC_MESSAGES-}" "${LANG-}"; do
        VISUALIZER_LANG_VALUE=${VISUALIZER_LANG_VALUE%%.*}
        case "$VISUALIZER_LANG_VALUE" in
            [kK][oO]|[kK][oO]_*|[kK][oO]-*) printf '%s\n' ko; return 0 ;;
            [eE][nN]|[eE][nN]_*|[eE][nN]-*) printf '%s\n' en; return 0 ;;
        esac
    done
    printf '%s\n' en
}

# visualizer_text KEY [ARGUMENT]: prints one message (with a trailing newline) in $VISUALIZER_LANG,
# which the caller sets from visualizer_lang. ARGUMENT is the one variable part (an option, a URL
# or a directory), always shown in $2. An unknown key prints the key itself.
visualizer_text() {
    case "$VISUALIZER_LANG:$1" in
        en:help_main)
            printf '%s\n' 'Usage: sh /path/to/ai-agents-visualizer/bin/launch.sh [--browser | --server-only]'
            printf '%s\n' "Default: reuse or start the server, then open it in the current VS Code window's integrated browser"
            printf '%s\n' '--browser: reuse or start the server, then open it in the system default browser'
            printf '%s\n' "Script for the default browser only: $2/launch-browser.sh"
            printf '%s\n' '--server-only: prepare the server without opening a browser'
            printf '%s\n' 'Language: set WAS_LANG=en or WAS_LANG=ko (otherwise LC_ALL, LC_MESSAGES and LANG decide; default: English)'
            ;;
        ko:help_main)
            printf '%s\n' '사용법: sh /경로/ai-agents-visualizer/bin/launch.sh [--browser | --server-only]'
            printf '%s\n' '기본 동작: 서버 재사용/시작 후 현재 VS Code 창의 내장 브라우저로 열기'
            printf '%s\n' '--browser: 서버 재사용/시작 후 시스템 기본 브라우저로 열기'
            printf '%s\n' "기본 브라우저 전용 스크립트: $2/launch-browser.sh"
            printf '%s\n' '--server-only: 브라우저를 열지 않고 서버만 준비'
            printf '%s\n' '언어: WAS_LANG=en 또는 WAS_LANG=ko로 지정 (없으면 LC_ALL, LC_MESSAGES, LANG 순서로 판단, 기본값은 영어)'
            ;;
        en:help_browser)
            printf '%s\n' "Usage: $2/launch-browser.sh"
            printf '%s\n' 'Reuses or starts the server and opens it in the system default browser. VS Code and Accessibility permission are not required.'
            ;;
        ko:help_browser)
            printf '%s\n' "사용법: $2/launch-browser.sh"
            printf '%s\n' '서버를 재사용/시작하고 시스템 기본 브라우저로 엽니다. VS Code와 손쉬운 사용 권한은 필요하지 않습니다.'
            ;;
        en:browser_no_options) printf '%s\n' 'Run launch-browser.sh without options.' ;;
        ko:browser_no_options) printf '%s\n' 'launch-browser.sh는 옵션 없이 실행해주세요.' ;;
        en:opt_unknown) printf '%s\n' "Unknown option: $2" ;;
        ko:opt_unknown) printf '%s\n' "알 수 없는 옵션: $2" ;;
        en:opt_conflict) printf '%s\n' 'Use only one of --browser or --server-only.' ;;
        ko:opt_conflict) printf '%s\n' '옵션은 --browser 또는 --server-only 중 하나만 사용할 수 있습니다.' ;;
        en:node_missing) printf '%s\n' 'Could not find Node.js 22 or later. Install Node.js or check your PATH.' ;;
        ko:node_missing) printf '%s\n' 'Node.js 22 이상을 찾지 못했습니다. Node.js를 설치하거나 PATH를 확인해주세요.' ;;
        en:node_old) printf '%s\n' 'Node.js 22 or later is required. Check your PATH or AI_AGENTS_NODE_BIN.' ;;
        ko:node_old) printf '%s\n' 'Node.js 22 이상이 필요합니다. PATH 또는 AI_AGENTS_NODE_BIN을 확인해주세요.' ;;
        en:url_bad) printf '%s\n' 'The server did not return a valid local address.' ;;
        ko:url_bad) printf '%s\n' '서버가 올바른 로컬 주소를 반환하지 않았습니다.' ;;
        en:not_macos) printf '%s\n' 'Opening a browser automatically is supported on macOS only.' ;;
        ko:not_macos) printf '%s\n' '브라우저 자동 열기는 macOS용입니다.' ;;
        en:open_manual) printf '%s\n' "Please open it in a browser yourself: $2" ;;
        ko:open_manual) printf '%s\n' "브라우저에서 직접 열어주세요: $2" ;;
        en:open_missing) printf '%s\n' 'Could not find the open command that opens the default browser.' ;;
        ko:open_missing) printf '%s\n' '기본 브라우저를 여는 open 명령을 찾지 못했습니다.' ;;
        en:open_failed) printf '%s\n' 'Failed to open the default browser. The server is ready.' ;;
        ko:open_failed) printf '%s\n' '기본 브라우저 열기에 실패했습니다. 서버는 준비되어 있습니다.' ;;
        en:open_sent) printf '%s\n' 'Sent the open command to the system default browser.' ;;
        ko:open_sent) printf '%s\n' '시스템 기본 브라우저에 열기 명령을 보냈습니다.' ;;
        en:osa_missing) printf '%s\n' 'Could not find macOS osascript.' ;;
        ko:osa_missing) printf '%s\n' 'macOS osascript를 찾지 못했습니다.' ;;
        en:osa_no_code) printf '%s\n' 'Visual Studio Code is not open.' ;;
        ko:osa_no_code) printf '%s\n' '현재 열린 Visual Studio Code가 없습니다.' ;;
        en:osa_no_window) printf '%s\n' 'There is no open Visual Studio Code window.' ;;
        ko:osa_no_window) printf '%s\n' '현재 열린 Visual Studio Code 창이 없습니다.' ;;
        en:osa_no_palette) printf '%s\n' 'Could not confirm the command palette. Nothing was typed.' ;;
        ko:osa_no_palette) printf '%s\n' '명령 팔레트를 확인하지 못했습니다. 검색문을 입력하지 않았습니다.' ;;
        en:osa_focus_search) printf '%s\n' 'VS Code lost focus. Nothing was typed.' ;;
        ko:osa_focus_search) printf '%s\n' 'VS Code 포커스가 바뀌었습니다. 검색문을 입력하지 않았습니다.' ;;
        en:osa_no_urlfield) printf '%s\n' 'Could not confirm the integrated browser URL field. The URL was not typed.' ;;
        ko:osa_no_urlfield) printf '%s\n' '내장 브라우저 URL 입력란을 확인하지 못했습니다. URL을 입력하지 않았습니다.' ;;
        en:osa_focus_url) printf '%s\n' 'VS Code lost focus. The URL was not typed.' ;;
        ko:osa_focus_url) printf '%s\n' 'VS Code 포커스가 바뀌었습니다. URL을 입력하지 않았습니다.' ;;
        en:vscode_failed) printf '%s\n' 'Failed to open the VS Code integrated browser automatically. The server is ready.' ;;
        ko:vscode_failed) printf '%s\n' 'VS Code 내장 브라우저 자동 열기에 실패했습니다. 서버는 준비되어 있습니다.' ;;
        en:vscode_a11y) printf '%s\n' 'If this is an accessibility error, check the permission of the terminal you ran this from under System Settings → Privacy & Security → Accessibility.' ;;
        ko:vscode_a11y) printf '%s\n' '접근성 오류라면 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 실행 터미널의 권한을 확인해주세요.' ;;
        en:vscode_manual) printf '%s\n' "Open manually: in the current VS Code window press Cmd+Shift+P → Browser: Open Integrated Browser → $2" ;;
        ko:vscode_manual) printf '%s\n' "수동 열기: 현재 VS Code 창에서 Cmd+Shift+P → Browser: Open Integrated Browser → $2" ;;
        en:vscode_browser) printf '%s\n' "Open in the default browser instead: $2/launch-browser.sh" ;;
        ko:vscode_browser) printf '%s\n' "기본 브라우저로 열기: $2/launch-browser.sh" ;;
        en:vscode_sent) printf '%s\n' "Sent the open command to the current VS Code window's integrated browser." ;;
        ko:vscode_sent) printf '%s\n' '현재 VS Code 창의 내장 브라우저에 열기 명령을 보냈습니다.' ;;
        *) printf '%s\n' "$1" ;;
    esac
}
