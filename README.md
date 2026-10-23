# AI Agents Visualizer

A local, read-only control room for [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) sessions. It reads the session records already on your machine and shows the session / sub-agent hierarchy and the collaboration between agents. The first screen is **All projects / last 2 hours**.

It needs only Node.js 22 or later. There are no packages to install and no external network access.

> **Languages:** the web UI and the terminal messages come in English and Korean. See [Language](#language).

## Requirements

- Node.js 22 or later
- Claude Code and/or Codex session records on the same machine (`~/.claude`, `~/.codex`)
- A browser with WebGL for the character view (the hierarchy list and relation graph work without it)

## Quick start

```sh
git clone https://github.com/whooperlove/ai-agents-visualizer.git
cd ai-agents-visualizer
node server.js
```

Then open <http://127.0.0.1:4317>. Press `Ctrl+C` in the terminal to stop the server.

To try the UI with synthetic data (a made-up hierarchy with relation conflicts), add the demo supplement:

```sh
node server.js --supplement examples/demo.json
```

### Launcher scripts (macOS)

The scripts in `bin/` start the server (or reuse one already running on `127.0.0.1:4317`) and open it for you. They target macOS; on other platforms start the server with `node server.js` and open the URL yourself.

| Opens in | Script |
| --- | --- |
| System default browser | `bin/launch-browser.sh` |
| The current VS Code's integrated browser | `bin/launch.sh` |

The default-browser script takes no options and needs neither VS Code nor Accessibility permission:

```sh
./bin/launch-browser.sh
```

`bin/launch.sh` opens **Browser: Open Integrated Browser** in the most recently active VS Code window and types the URL. It does not install or modify any settings or extensions. Without macOS Automation / Accessibility permission the automatic typing can fail; the script then prints the server URL and the manual steps. It never falls back to another browser on its own.

```sh
./bin/launch.sh                 # VS Code integrated browser
./bin/launch.sh --browser       # same as launch-browser.sh (uses macOS `open`; does not change your default browser)
./bin/launch.sh --server-only   # start or reuse the server without opening anything
```

To open it manually in VS Code: `Cmd+Shift+P` → `Browser: Open Integrated Browser` → `http://127.0.0.1:4317`. On versions without that command, use `Simple Browser: Show` with the same URL.

### Server options

```sh
node server.js --port 4318 --supplement examples/demo.json
```

| Option | Meaning |
| --- | --- |
| `--port` | Port to listen on (default `4317`) |
| `--supplement <file>` | Supplement JSON file; may be given several times. By default none is loaded |
| `--no-supplement` | Use only auto-collected data |
| `--home <dir>` | Home directory to observe (default: your home directory) |
| `--poll-ms <ms>` | Re-scan interval (default `2500`, minimum `250`) |
| `--lang <en\|ko>` | Language of terminal and HTTP error messages (see [Language](#language)) |

The HTTP API is read-only.

## Language

The web UI and the terminal output are available in English and Korean.

- **Web UI:** the language follows your browser: a Korean browser gets Korean, everything else gets English. Use the language selector at the top right to switch at any time without reloading; the choice is remembered in the browser. Opening `http://127.0.0.1:4317/?lang=ko` or `?lang=en` overrides it for that visit.
- **Terminal and launcher scripts:** the language comes from `--lang en|ko` (server only), then the `WAS_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG` environment variables, and defaults to English. `bin/launch.sh` and `bin/launch-browser.sh` follow the same variables and read their messages from `bin/launch-messages.sh`, which must stay next to them.
- **What is translated:** every label, tooltip, status and diagnostic the tool produces itself, including the notes the server attaches to sessions (status evidence, conflict and diagnostic messages). Session names, descriptions, paths and anything else that comes from your own records or supplement files is shown as it was recorded.
- **For contributors:** messages live in `public/locales/*.js` as `{ en, ko }` pairs. `npm test` checks that both languages have the same keys and placeholders, that every key used in the code exists, and that no Korean text is hard-coded in the source files.

## Activity and status

Activity scope and run status are separate pieces of information. An old record is never assumed to be a terminated process.

| Activity scope | Classified by |
| --- | --- |
| Recent activity | Events within the last 2 hours. This does not mean the session is running now |
| Inactive / past | Completed or stopped sub-agents, sessions with no new event for over 2 hours, and entries marked `archived: true` in a supplement JSON |
| Unknown | No last-event time, or a future timestamp that cannot be trusted |
| All | Everything above |

The default recent-activity view leaves out past nodes and stale collaboration or document-derived relations, and shows how many were left out. If a recent child's parent is inactive, the parent stays as context so the hierarchy remains understandable. A completed agent is always classified as inactive, even if it completed recently. Old records and explicitly retired sessions are never deleted.

`running` and `waiting` are inferred from recent events and turn into `unknown` when the status evidence has not been refreshed for more than 2 minutes. `idle` means the last turn ended; `completed` means there is evidence the agent finished. None of these guarantee that the process is alive or that a VS Code panel is open. A bridge's `queued` and `delivered` describe message delivery and do not change a session's run status. Even when a reply is recorded, the tool does not judge whether the requested work succeeded.

## Navigation

- The side-menu toggle collapses and reopens the filter area. The collapsed state is saved in the browser; `Alt+B` also toggles it.
- The hierarchy list is virtualized and collapses branches by default. Use `↑ ↓`, `← →` and `Enter` to move, collapse, expand and select.
- Search also finds collapsed children and expands the ancestors it needs. Project, provider, activity scope, run status and node kind filters can be combined. To search past sessions, set the activity scope to All.
- The relation graph sizes its canvas to the display's real pixel density. You can zoom, drag to pan, fit everything, and focus on a branch.
- The **Background dot grid** toggle above the graph turns the dotted background on and off. The choice is saved in the browser and survives reloads and the wide view.
- Nodes outside the viewport are only skipped when drawing. No data is dropped because of node count or depth. Relation details and diagnostics show the full counts and can be expanded to the end with the show-more buttons.
- Relation type, direction, confirmed / inferred / unresolved status and source evidence are shown in the details panel. Multiple parents, cycles and ambiguous aliases produce warnings while the original relations are preserved.
- File changes are picked up by file watching and periodic re-scanning and pushed to the page over SSE. Selection, collapsed branches and filters survive updates.

## Logical management relations and message flow

Operational relations are drawn as `management` edges. A `management` edge means a coordinator manages an assigned session; it does not mean the coordinator created that session's process. The actual creation hierarchy stays as `spawn`. Roles such as coordinator, assignee or writer are shown through the optional `role` metadata. A coordinator is never chosen just because a name contains "master".

Relations that come from documents are split into those stated directly and those inferred from context, and the source path and line evidence is kept. Idle logical assignees can be viewed as team context, and thousands of completed sub-tasks are not expanded as if they were team members. Shared management and management cycles are reported separately from conflicts between actual spawn parents.

Between any two sessions all relations are merged into **one solid connection**. It shows the relation kinds (management, spawn, collaboration, ...), bidirectional arrows, the delivery count and the unresolved count; inferred and unresolved relations are marked with text badges. Selecting a connection label shows the per-direction requests, replies and status between the two sessions, with the individual source evidence. Merging lines on screen never deletes the underlying relations or delivery records.

Cross-agent records keep the delivery ID, the original request ID, the created / accepted / completed times and the link between a request and its reply. `reply-recorded` means a reply record exists; `transcript-confirmed` means the reply was confirmed in the transcript. Neither says that the requested work succeeded. Message bodies are not shown in the read view.

When a new delivery or status change is observed, the connection and nodes for that direction are briefly highlighted. This marks a newly observed delivery record; it is not a measurement of when anything was actually sent over a network. During the initial scan, past records are not replayed as live events, and receiving the same snapshot again does not create duplicate effects. **Replay recent deliveries** plays the 12 most recent deliveries of the current project in time order, labelled "replay · not real time" together with the number of off-screen targets. Replay can be stopped, and hidden records stay available in the details and the full view.

## Rename detection

When the name of a session ID changes, the page follows automatically. The most recent value among Claude's `custom-title` records and `custom-title.json`, and Codex's `session_index.jsonl`, becomes the name. The **Renamed** field in the details shows the order `previous name → … → current name`.

- History is built from the records that were read, and renames observed while running are appended in server memory. Large JSONL files are read only for their first 256 KiB and last 128 KiB, so older renames outside that range may not be visible. After a server restart the history returns to what can be read from the records.
- For a renamed session, the supplement name is kept as an alias, so relations in a supplement that still use the old name keep pointing at the same session.

## Wide view

**Wide view** draws the current project's graph large inside the browser area it is given. It shrinks the filter menu and details area and keeps the project name, status, relation legend and the close button. It does not call the browser's or VS Code's fullscreen feature. **Close wide view** or `Esc` returns to the previous filter, selection and layout state.

Highlights for genuinely new records are distinguished from replays you explicitly start. Unnecessary motion is reduced while the browser tab is in the background and under the operating system's reduce-motion setting. When nothing new is observed, no fake traffic is generated to make it look like messages are flowing.

## Character office: side-scrolling stage

The **Characters** view is a near-front-facing, side-scrolling stage. In a dusk-lit office and sofa lounge, 3D characters express the observed state through posture and facial expression. The name tag above a head shows the full name (provider prefixes and long names are never truncated), a status dot, a **Codex / Claude** badge, the activity scope and a status phrase. Many sessions scroll horizontally; characters outside the screen are only skipped when drawing.

- **Desk / sofa:** sessions with recent activity sit at desk chairs; inactive and completed sessions sit on the sofa. Being in a filter's context is not by itself a reason to treat a session as inactive. Recent activity means a record within 2 hours and is independent of whether the session is running now.
- **Poses by status:** a character at a desk faces the dual monitors on the wall, so the camera sees its back and the screens. When work is observed it types and code scrolls on the screen. When waiting for a reply it half-turns the chair and clasps its hands behind its head while an input-waiting window shows on screen. When idle it turns the chair toward the camera holding a mug; when the status is unknown it freezes in front of a dimmed screen. On the sofa it has a relaxed expression, and a completed session dozes. All of this is a visual rendering of the recorded state and does not judge actual execution or success.
- **Opening and closing details:** clicking a name tag or character opens the details. Clicking the already selected session closes the details and clears the selection; clicking another session switches to it. The **X button** at the top right of the details panel closes it from any view and follows you while the panel scrolls. In the character view the wide view has no **Session details** button at the top.
- **Turning around:** selecting a character turns its chair to the camera and it waves. During a phone animation it also turns the chair to take the call. With reduced motion it turns instantly without a rotation animation.
- **Smartphone call animation:** when a new message record is observed, the sender is shown calling and the receiver answering. Between two phones on the same screen, signal dots draw an arc; if the other party is off screen or on another floor, the signal leaves through the top of the screen. Characters never walk or change floors to deliver a message. No stage text (calling / ringing / on call) is attached next to a character; a single line under the stage reads "record-based · not a real call" and says only who is calling whom.
- **Automatic call replay:** opening the character view replays once, in time order, the latest 12 delivery records from the last 2 hours that the current filters allow. There is no button for it. Call animations are a display based on message records and do not mean a real call or completed work. Past records from the initial scan are not replayed as new messages.
- **Floors / floor selection:** floors are teams derived from management and spawn evidence. Turning off **By floor** merges them into one horizontal stage. A large badge at the top left of the stage always shows the current floor number, team name and location, and **Shift + wheel** moves one floor up or down at a time.
- **Communication cards:** to the right of each character's name tag, the sessions it has exchanged messages with are stacked vertically as yellow sticky-note cards (with a folded corner and a lower shadow so they stand out from the dark name tags). A card shows the full session name (never truncated), a status dot and the time of the last communication, plus the count of unresolved messages when replies are still pending. Agent type and sent / received counts are not shown. New conversations enter at the top; 30 minutes after the last conversation the oldest cards (at the bottom) fade out gradually and disappear. Clicking a card selects that session and the stage moves to it.
- **Horizontal navigation:** move with the left / right buttons, by dragging or with the wheel, and change the size with the zoom buttons. Double-click the stage or press Home to fit the view (this is also applied automatically when you change floors). The **All sessions on this floor** list at the bottom left of the stage is the only session-selection menu: it highlights the currently selected session, and choosing one closes the list and moves to that session.
- **Wide view:** fills the current browser area without calling the browser's or VS Code's fullscreen.

The shared 3D model is in [`public/character-model.js`](public/character-model.js). A single rounded base shape (a cube sphere) is expanded in the shader into spheres, capsules, rounded boxes and cylinders to draw both characters and furniture. Eyes, highlights, eyebrows, blush, mouth and glasses are drawn in the shader, and the hair is cut into a bangs shape. Eight hairstyles, six outfits (T-shirt, hoodie, cardigan, shirt, sweater, overalls), glasses, headphones and the skin, hair, clothing and shoe colors are chosen from the session ID, so the look stays the same when a session updates. No external model service or CDN is contacted.

The stage renderer, [`public/office-scene.js`](public/office-scene.js), uses shadow maps, hemisphere light, rim light, a lamp point light and tone mapping. The wooden floor, the night view outside the window, the monitor screens, the rug and the picture frames are drawn in shaders. Frames keep updating only while work, a call animation or a seat move is on screen; otherwise the stage is a still image. With the browser's reduce-motion setting, motion is turned off.

Rendering the 3D characters needs WebGL. In environments without it, the page shows a notice and the full session list, and the hierarchy list and relation graph keep working. If a framebuffer for shadows cannot be created, the scene is drawn without shadows.

The earlier 3D diagram mode was removed. A previously saved preference for that view maps to the character view. The hierarchy list and the relation graph remain available.

## Observed sources

The tool reads these locations under the home directory. Anything that does not exist is skipped.

| Kind | Path and what is collected |
| --- | --- |
| Claude | JSONL files under `~/.claude/projects` and (if you keep extra account directories) `~/.claude-accounts/*/projects`; `custom-title.json`; `subagents/agent-*.meta.json` |
| Account assignment | Only the session ID → profile name map in `~/.config/claude-multi-accounts/claude-accounts.json`, if present |
| Codex | Rollout files under `~/.codex/sessions` and `~/.codex/session_index.jsonl` |
| Collaboration | `~/.cross-agent/registry.json`, `~/.cross-agent/deliveries` and `in-flight`, written by a local cross-agent message bridge, if you use one |
| Supplement | Explicit JSON files passed with `--supplement` |

Claude grandchildren use `parentAgentId` and `spawnDepth`; Codex uses `session_meta.parent_thread_id` and `source.subagent.thread_spawn`. A deep agent whose parent was not recorded is shown with an unresolved parent. When the same physical file is visible through several account paths, it is read once and all of its sources are kept. The real account is never guessed from the observed path alone.

The initial read of a large JSONL file uses the first 256 KiB and the last 128 KiB, and then follows whatever is appended afterwards. The first metadata line is read further, within a 4 MiB range. The amount of skipped middle history, parse failures and lines over 4 MiB are shown as diagnostics. Small indexes are stream-read in full. File deletion, atomic replacement, truncation and partially written UTF-8 are handled. **This is not a tool for reconstructing every past conversation.**

Nothing is written to the sources. The server binds to `127.0.0.1` only and rejects foreign Origin / Host headers and write methods. The UI and API expose only allow-listed names, IDs, timestamps, models, statuses, tool names, short metadata descriptions and sources. Prompts, tool inputs and outputs, bridge message bodies and summary text are never exposed. The automatic collectors never send bridge messages or register hooks.

## Supplement JSON

Schema: [`schema/supplement.schema.json`](schema/supplement.schema.json)

Synthetic hierarchy and conflict example: [`examples/demo.json`](examples/demo.json)

```json
{
  "schemaVersion": 1,
  "sessions": [
    { "id": "claude:session-id", "name": "Control parent", "aliases": ["master"], "project": "my-project", "role": "master" },
    { "id": "codex:child-id", "name": "Worker child", "project": "my-project", "archived": false }
  ],
  "relations": [
    { "id": "assignment-1", "from": "master", "to": "codex:child-id", "type": "management", "confidence": "confirmed" },
    { "id": "wait-1", "from": "master", "to": "codex:child-id", "type": "dependency", "description": "Waiting for the child's report", "requestId": "req_example", "confidence": "inferred" }
  ]
}
```

IDs are `claude:<session ID>` or `codex:<session ID>`. A Claude child is `claude:<root session ID>:agent:<agent ID>`. Relation endpoints use an ID or an alias; if the same alias points at several sessions, none is picked arbitrarily. `description` and `role` are supplementary metadata for this screen and never change the real session. `name` is used for display only when no name has been observed for the session (an unobserved session, or one that only has a temporary name). When the name of a session ID changes, the newest observed name is applied automatically without editing the supplement JSON, and the supplement name is kept under **Aliases** in the details and as a relation-endpoint alias. In that case the supplement's `archived` is not applied, and a `supplement-name-stale` diagnostic is recorded so you can check whether the supplement's role and description are still current. `archived` only changes the view classification and never overrides the real run status.

| Relation | Direction |
| --- | --- |
| `spawn` | parent → child |
| `management` | logical coordinator → assigned session (separate from creation) |
| `dependency` | the waiting side → what it waits for |
| `collaboration` | sender → receiver |
| `handoff` | previous owner → next owner |

A relation's `evidence.path` and `evidence.detail` can hold the source document and a line description. The path is for display only; the server never opens that file on its own. `confidence` is `confirmed`, `inferred` or `unresolved`. If a declared counterpart cannot be found in the real records, it is kept as unresolved. A "waiting" example taken from a document is a snapshot with a collection date and does not mean something is waiting now. Source Markdown documents are not re-interpreted automatically, so the supplement JSON has to be updated to reflect newer semantic relations.

Edits to a supplement JSON are applied while the server runs. Invalid JSON or schema keeps the last valid version and shows the error. Relations from a deleted supplement file are removed. Duplicate session or relation IDs and unknown fields are rejected. The file size limit is 16 MiB and there is no node-count limit.

## Tests

```sh
npm test
npm run verify:live
```

`npm test` runs against synthetic home directories without touching your real records. It covers incremental collection, deletion and replacement, account assignment, a 12,000-level hierarchy, relation conflicts, inactive separation, HTTP security and SSE. It also checks that the English and Korean message catalogs match. Temporary directories created by the tests are removed when they finish.

`npm run verify:live` reads your real session records, read-only, and prints only metadata counts (never transcript bodies). The numbers vary with whichever sessions are active at the time you run it.

## License

[MIT](LICENSE)
