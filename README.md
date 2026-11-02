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

The server runs detached, so closing the terminal does not stop it. To stop the server that `launch.sh` started:

```sh
./bin/stop.sh
```

`bin/stop.sh` takes no options. It sends `SIGTERM` only to a process that answers `http://127.0.0.1:4317/api/health` as this application and is confirmed by `lsof` to be listening on port 4317; a port held by anything else is left alone. It waits until the port is free, and reports success (exit 0) as well when no server is running. If the server does not exit in time it prints the `kill -9` command instead of forcing it. It needs `curl` and `lsof`.

### Server options

```sh
node server.js --port 4318 --supplement examples/demo.json
```

| Option | Meaning |
| --- | --- |
| `--port` | Port to listen on (default `4317`) |
| `--supplement <file>` | An additional supplement JSON file from anywhere; may be given several times. Files in the [supplement folder](#where-supplement-files-go) are always loaded as well |
| `--no-supplement` | Ignore the supplement folder and use only auto-collected data |
| `--home <dir>` | Home directory to observe (default: your home directory) |
| `--poll-ms <ms>` | Re-scan interval (default `2500`, minimum `250`) |
| `--lang <en\|ko>` | Language of terminal and HTTP error messages (see [Language](#language)) |

The HTTP API is read-only.

## Remembered choices

The page keeps your choices in the browser's local storage (`localStorage` of `http://127.0.0.1:<port>`), not on the server, so they survive a closed tab, a reload and a restart of the server: the filters and the search text, the view (list, graph or character stage), the sort order, the connection scope and relation types, the stage's floor, seat order and toggles, the selected session, the focused branch and the expanded branches. The language, the grid toggle and the collapsed panels were already kept the same way.

A restarted server is empty at first and sends a partial snapshot marked "partial" until it has read your session records. During that time a remembered selection, focus or floor that is not in the data yet is kept and applied as soon as it appears; once the scan has finished, one that no longer exists is dropped. Clicking or typing during the scan cancels the waiting choice.

The choices belong to the browser profile and to the address, so `localhost` and `127.0.0.1`, other ports and private windows each have their own.

## Language

The web UI and the terminal output are available in English and Korean.

- **Web UI:** the language follows your browser: a Korean browser gets Korean, everything else gets English. Use the language selector at the top right to switch at any time without reloading; the choice is remembered in the browser. Opening `http://127.0.0.1:4317/?lang=ko` or `?lang=en` overrides it for that visit.
- **Terminal and launcher scripts:** the language comes from `--lang en|ko` (server only), then the `WAS_LANG`, `LC_ALL`, `LC_MESSAGES` and `LANG` environment variables, and defaults to English. `bin/launch.sh`, `bin/launch-browser.sh` and `bin/stop.sh` follow the same variables and read their messages from `bin/launch-messages.sh`, which must stay next to them.
- **What is translated:** every label, tooltip, status and diagnostic the tool produces itself, including the notes the server attaches to sessions (status evidence, conflict and diagnostic messages). Session names, descriptions, paths and anything else that comes from your own records or supplement files is shown as it was recorded.
- **For contributors:** messages live in `public/locales/*.js` as `{ en, ko }` pairs. `npm test` checks that both languages have the same keys and placeholders, that every key used in the code exists, and that no Korean text is hard-coded in the source files.

## Activity and status

Activity scope and run status are separate pieces of information. An old record is never assumed to be a terminated process.

| Activity scope | Classified by |
| --- | --- |
| Recent activity | Events or verified Claude runtime observations within the last 2 hours. This does not mean the session is running now |
| Inactive / past | Completed or stopped sub-agents, sessions with no new event for over 2 hours, and entries marked `archived: true` in a supplement JSON (shown only under the `all` activity filter; [`exclude`](#excluding-sessions) hides them altogether) |
| Unknown | No last-event time, or a future timestamp that cannot be trusted |
| All | Everything above |

The default recent-activity view leaves out past nodes and stale collaboration or document-derived relations, and shows how many were left out. If a recent child's parent is inactive, the parent stays as context so the hierarchy remains understandable. A completed agent is always classified as inactive, even if it completed recently. Old records and explicitly retired sessions are never deleted.

Claude's native runtime records under `~/.claude/sessions` and `~/.claude-accounts/*/sessions` take precedence for root sessions when their PID and process start time match a live process. Runtime `busy` means `running`, `waiting` means `waiting`, and `idle` / `shell` mean `idle`. Each verified observation refreshes the last-observed time, so a long API request stays running even when the transcript has no new lines. A deleted record, a dead process, a reused PID or conflicting runtime states falls back to transcript evidence. A root's runtime state never overrides its sub-agents.

Without verified runtime evidence, `running` is inferred from recent execution events and turns into `unknown` after 2 minutes without refreshed evidence. Codex reasoning, assistant messages and both function and custom tool calls/results refresh that evidence; an assistant message with `phase: final_answer` records the end of a turn. An explicit `waiting` event remains waiting until a later execution, completion or interruption event arrives. `idle` means the last turn ended; `completed` means there is evidence the agent finished. Log-only statuses do not guarantee that the process is alive or that a VS Code panel is open. A bridge's `queued` and `delivered` describe message delivery and do not change a session's run status. Claude user records marked `queueTranscriptOnly: true` likewise do not start a turn or replace its last execution evidence. Even when a reply is recorded, the tool does not judge whether the requested work succeeded.

## Navigation

- The side-menu toggle collapses and reopens the filter area. The collapsed state is saved in the browser; `Alt+B` also toggles it.
- The hierarchy list is virtualized and collapses branches by default. Use `↑ ↓`, `← →` and `Enter` to move, collapse, expand and select.
- Search also finds collapsed children and expands the ancestors it needs. Project, provider, activity scope, run status and node kind filters can be combined. To search past sessions, set the activity scope to All.
- The relation graph sizes its canvas to the display's real pixel density. You can zoom, drag to pan, fit everything, and focus on a branch.
- The default **Operating relations** layout arranges cards by who manages whom. A manager heads a lane (a labelled panel) that holds its members in a grid; a member that manages others heads a lane of its own to the right of its manager's lane, and the management lines to those lanes run along one shared trunk, so reading left to right follows the chain of management. Sessions that belong to no team share one panel below. The management and spawn lines between a head and the members inside its own lane are left out, because the lane already says it; they appear when you hover or select either end, and any line that carries a delivery or a conflict is always drawn. The **Spawn hierarchy** layout stays an indented list of the original creation tree.
- Only the visible view is built. The graph's layout and routing, the hierarchy list's rows and the character scene are each made when their view is shown and left alone while it is hidden; switching back rebuilds a view that is out of date from the current data.
- Hovering a session or a connection label lightly dims everything that is not directly linked to it; selecting one dims the rest firmly. Click empty canvas or press `Esc` to let go of the selection.
- The graph changes its level of detail with the zoom: full cards, then names only, then plain status-tinted blocks (team heads keep their names). At the middle zoom step, only a connection that is in focus or in conflict keeps a small mark on its line; further out, only the lines remain. When part of a larger graph is out of view, a minimap in the lower right shows every session by status color and the current view; click or drag on it to move there.
- Each card shows its status as a shape: a spinning ring while running, a clock when waiting, a check when completed, an exclamation mark when interrupted, a ring with a bar when idle and a ring with a dot when unknown. The rail on its left edge is the provider's color, and the bar at the bottom of an operating-layout card is the share of the messages that session sent which are already resolved (the unresolved share is shown in the waiting color).
- The **Background dot grid** toggle above the graph turns the dotted background on and off. The choice is saved in the browser and survives reloads and the wide view.
- Nodes outside the viewport are only skipped when drawing. No data is dropped because of node count or depth. Relation details and diagnostics show the full counts and can be expanded to the end with the show-more buttons.
- Relation type, direction, confirmed / inferred / unresolved status and source evidence are shown in the details panel. Multiple parents, cycles and ambiguous aliases produce warnings while the original relations are preserved.
- File changes are picked up by file watching and periodic re-scanning and pushed to the page over SSE. Selection, collapsed branches and filters survive updates.

## Logical management relations and message flow

Operational relations are drawn as `management` edges. A `management` edge means a coordinator manages an assigned session; it does not mean the coordinator created that session's process. The actual creation hierarchy stays as `spawn`. Roles such as coordinator, assignee or writer are shown through the optional `role` metadata. A coordinator is never chosen just because a name contains "master".

Relations that come from documents are split into those stated directly and those inferred from context, and the source path and line evidence is kept. Idle logical assignees can be viewed as team context, and thousands of completed sub-tasks are not expanded as if they were team members. Shared management and management cycles are reported separately from conflicts between actual spawn parents.

Between any two sessions all relations are merged into **one connection line**. It shows the relation kinds (management, spawn, collaboration, ...), bidirectional arrows, the delivery count and the unresolved count. Lines are always solid; how many relations of the pair are inferred or unconfirmed is counted in the label. A line takes the color of its relation type, except a messaging line (a pair that carries deliveries), which has a color of its own: the color its beam travels in, so each messaging connection can be told apart. The label's colored bar still lists every relation type the pair carries. A bright stretch that runs along a messaging line marks a delivery that is still unresolved: one beam per connection, exactly as wide as the line, brightening toward its head and travelling in the direction of the delivery, in the connection's own color (eight colors, handed out in the order the connections are first seen, and kept). The briefly highlighted new or replayed deliveries use the same beam in their connection's color, a replay somewhat dimmer. With reduced motion the beams stand still. A label that had to move away from its line is joined to it by a dotted leader. Selecting a connection label shows the per-direction requests, replies and status between the two sessions, with the individual source evidence. Merging lines on screen never deletes the underlying relations or delivery records.

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
- **Smartphone call animation:** when a new message record is observed, the sender is shown calling and the receiver answering. Between two phones on the same screen, signal dots draw an arc; if the other party is off screen or on another floor, the signal leaves through the top of the screen. Characters never walk or change floors to deliver a message. No stage text (calling / ringing / on call) is attached next to a character; a single line under the stage, shown only while a call is playing, says only who is calling whom.
- **Automatic call replay:** opening the character view replays once, in time order, the latest 12 delivery records from the last 2 hours that the current filters allow. There is no button for it. Call animations are a display based on message records and do not mean a real call or completed work. Past records from the initial scan are not replayed as new messages.
- **Floors / floor selection:** floors are teams derived from management and spawn evidence: management teams come first, then a spawn tree that has at least two sessions on show, and last one floor of independent sessions, which also takes the lone session of a tree whose other sessions are hidden. A supplement can also define [logical groups](#logical-groups): each group then gets its own floors (the same rules, applied inside the group), the most important group on the lowest floors, and the sessions of no group follow above them. The badge then reads, for example, `2F · Story · story-director`. Seats keep related sessions together (a team's manager first, a tree's root before its descendants, then one project after the other). Turning off **By floor** merges them into one horizontal stage. A large badge at the top left of the stage always shows the current floor number, team name and location, and **Shift + wheel** moves one floor up or down at a time.
- **Seat order:** the order select in the stage toolbar arranges the seats within each floor. *Grouped by messages* (the default) seats sessions that message each other side by side, the more messages the closer; the manager or tree root stays first, sessions that talk to nobody on the floor keep their place, and only messages between sessions of the same floor count. *Name* sorts A → Z with digits compared as numbers, *Status* puts working sessions first, then waiting, error, interrupted, unknown, idle and completed, and *Most messages first* ranks by messages sent and received; with these three nobody is pinned to the head of the floor. A message is counted once per delivery ID from every recorded message, however old, so seats do not shuffle as records age out of the recent window. When the order changes, characters walk to their new seats; resting sessions stay on the sofas and are ordered among themselves. The choice is remembered in the browser (see [Remembered choices](#remembered-choices)).
- **Communication cards:** to the right of each character's name tag, the sessions it has exchanged messages with are stacked vertically as yellow sticky-note cards (with a folded corner and a lower shadow so they stand out from the dark name tags). A card shows the full session name (never truncated), a status dot and the time of the last communication, plus the count of unresolved messages when replies are still pending. Agent type and sent / received counts are not shown. New conversations enter at the top; 30 minutes after the last conversation the oldest cards (at the bottom) fade out gradually and disappear. Clicking a card selects that session and the stage moves to it.
- **Horizontal navigation:** move with the left / right buttons, by dragging or with the wheel, and change the size with the zoom buttons. Double-click the stage or press Home to fit the view (this is also applied automatically when you change floors). The **All sessions on this floor** list at the bottom left of the stage is the only session-selection menu: it highlights the currently selected session, and choosing one closes the list and moves to that session.
- **Wide view:** fills the current browser area without calling the browser's or VS Code's fullscreen.

The shared 3D model is in [`public/character-model.js`](public/character-model.js). A single rounded base shape (a cube sphere) is expanded in the shader into spheres, capsules, rounded boxes and cylinders to draw both characters and furniture. Eyes, highlights, eyebrows, blush, mouth and glasses are drawn in the shader, and the hair is cut into a bangs shape. Eight hairstyles, six outfits (T-shirt, hoodie, cardigan, shirt, sweater, overalls), glasses, headphones and the skin, hair, clothing and shoe colors are chosen from the session ID, so the look stays the same when a session updates. No external model service or CDN is contacted.

The stage renderer, [`public/office-scene.js`](public/office-scene.js), uses shadow maps, hemisphere light, rim light, a lamp point light and tone mapping. The wooden floor, the night view outside the window, the monitor screens, the rug and the picture frames are drawn in shaders. While a character is on stage the frames keep updating, because characters breathe, blink and sip: at most about 30 frames a second in the focused window. A window without the focus and a hidden tab draw no in-between frames: the stage redraws only when something changes and shows the new state at once, with no walk or turn in between. An empty stage is a still image. With the browser's reduce-motion setting, motion is turned off.

Rendering the 3D characters needs WebGL. In environments without it, the page shows a notice and the full session list, and the hierarchy list and relation graph keep working. If a framebuffer for shadows cannot be created, the scene is drawn without shadows.

The earlier 3D diagram mode was removed. A previously saved preference for that view maps to the character view. The hierarchy list and the relation graph remain available.

## Observed sources

The tool reads these locations under the home directory. Anything that does not exist is skipped.

| Kind | Path and what is collected |
| --- | --- |
| Claude | JSONL files under `~/.claude/projects` and (if you keep extra account directories) `~/.claude-accounts/*/projects`; `custom-title.json`; `subagents/agent-*.meta.json`; sibling `sessions/<pid>.json` runtime records, verified against read-only process start times |
| Account assignment | Only the session ID → profile name map in `~/.config/claude-multi-accounts/claude-accounts.json`, if present |
| Codex | Rollout files under `~/.codex/sessions` and `~/.codex/session_index.jsonl` |
| Collaboration | `~/.cross-agent/registry.json`, `~/.cross-agent/deliveries` and `in-flight`, written by a local cross-agent message bridge, if you use one |
| Supplement | `~/.config/ai-agents-visualizer/supplements/*.json` (see [Where supplement files go](#where-supplement-files-go)) and any files passed with `--supplement` |

Claude grandchildren use `parentAgentId` and `spawnDepth`; Codex uses `session_meta.parent_thread_id` and `source.subagent.thread_spawn`. A deep agent whose parent was not recorded is shown with an unresolved parent. When the same physical file is visible through several account paths, it is read once and all of its sources are kept. The real account is never guessed from the observed path alone.

The initial read of a large JSONL file uses the first 256 KiB and the last 128 KiB, and then follows whatever is appended afterwards. The first metadata line is read further, within a 4 MiB range. The amount of skipped middle history, parse failures and lines over 4 MiB are shown as diagnostics. Small indexes are stream-read in full. File deletion, atomic replacement, truncation and partially written UTF-8 are handled. **This is not a tool for reconstructing every past conversation.**

Nothing is written to the sources. The server binds to `127.0.0.1` only and rejects foreign Origin / Host headers and write methods. The UI and API expose only allow-listed names, IDs, timestamps, models, statuses, tool names, short metadata descriptions and sources. Prompts, tool inputs and outputs, bridge message bodies and summary text are never exposed. The automatic collectors never send bridge messages or register hooks.

## Supplement JSON

A supplement file describes what the session records cannot show on their own, for example which session coordinates which, or a retired session. It is plain JSON checked against a schema.

### Where supplement files go

Put them in the supplement folder and the server loads them automatically:

```text
~/.config/ai-agents-visualizer/supplements/*.json
```

- Every `*.json` file in the folder is loaded when the server starts. The folder is checked again at every re-scan, so you can add, edit or delete files while the server runs and the page follows. Files whose names start with a dot are ignored.
- The folder lives under the observed home directory, so `--home <dir>` moves it to `<dir>/.config/ai-agents-visualizer/supplements`.
- A missing folder is fine. A file that fails validation is reported as its own diagnostic and does not affect the other files.
- Because the folder is outside any repository, a private session map kept there cannot be committed by accident, and the launcher scripts (`bin/launch.sh`, `bin/launch-browser.sh`) pick it up without extra options.
- `--supplement <file>` loads a file from anywhere else in addition; `--no-supplement` ignores the folder.

### Format

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
  ],
  "groups": [
    { "id": "core", "name": "Coordination", "rank": 10, "members": ["claude:session-id"] },
    { "id": "workers", "name": "Workers", "rank": 20, "match": ["worker-*"] }
  ],
  "exclude": { "archived": true, "match": ["my-project-*-g??"] }
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

Edits to a supplement JSON are applied while the server runs. Invalid JSON or schema keeps the last valid version and shows the error. Relations from a deleted supplement file are removed. Duplicate session, relation or group IDs and unknown fields are rejected. The file size limit is 16 MiB and there is no node-count limit.

### Logical groups

The optional top-level `groups` array collects sessions into named groups, so that floors can be stacked by importance instead of only by the teams the records show. Every group lays out its own sessions on its own floors, and a group can span several floors.

| Field | Meaning |
| --- | --- |
| `id` | Unique group ID (required) |
| `name` | Text shown on the floor badge in front of the team name, up to 120 characters (required) |
| `rank` | Integer (required). **A smaller rank is a more important group and takes the lower floors**, so the group with the smallest rank starts at 1F. Groups of equal rank keep the order they are listed in. Negative ranks are fine |
| `description` | Free text for people reading the file (optional) |
| `members` | Session IDs (`claude:…` or `codex:…`) that belong to the group (optional) |
| `match` | Name patterns (optional): `*` is any run of characters, `?` is one character, anything else is literal and case is ignored. A pattern is tried against the session name and its aliases, so a session that appears later joins the group by name, for example `codex-koppa-i18n-*` |

Rules:

- **Floors inside a group:** the group's sessions are split into teams (`management`), spawn trees and independent sessions with the usual rules, but only the links between sessions of the same group count. A manager whose team sits in other groups, or a spawn tree that crosses a group border, does not drag sessions out of their group. A group with several floors is shown as `<group> · <team>`; a group whose only floor is its independent floor is shown by the group name alone.
- **Order of floors:** group by group in ascending `rank` from 1F upward; within a group, teams, then spawn trees, then independent sessions. Sessions in no group keep the usual rules and sit on floors above all groups.
- **A session claimed twice:** a listed `members` entry wins over a `match` pattern; among several of the same kind the group with the smaller rank wins (the one listed first when the ranks tie). The server records an `info` diagnostic, `supplement-group-overlap`, naming the groups and the one chosen. A group ID that a later supplement file repeats is ignored with a `supplement-group-duplicate` diagnostic.
- **Sub-agents:** a session that no group claims but that a grouped session spawned natively follows its spawn parent into the group, so a spawn tree stays together.
- **Without `groups`** nothing changes: the snapshot has no `groups` key and the floors are exactly those described above. A session or pattern that names nothing existing is simply ignored.

### Excluding sessions

The optional top-level `exclude` object leaves retired sessions out of the viewer altogether. `archived: true` on its own only marks a session inactive, so it still shows under the `all` activity filter and keeps its floor; a session that is excluded is not there at all.

| Field | Meaning |
| --- | --- |
| `archived` | `true` leaves out every session this file marks `archived: true`, also when the session's observed name no longer equals the name in the file (the rename rule that ignores `archived` for a session's inactive display does not apply here). Optional, default `false` |
| `match` | Name patterns with the same syntax as a group's `match` (`*` any run of characters, `?` one character, anything else literal, case ignored) (optional) |
| `unlisted` | `true` also leaves out every observed session that no supplement file lists in `sessions` (optional, default `false`). Needs `project` |
| `project` | Project pattern (same syntax; `*` for every project) that `unlisted` is limited to, compared with the session's project: the `project` of its supplement entry, else the folder name of its working directory. Required when `unlisted` is `true` |

```json
"exclude": { "archived": true, "unlisted": true, "project": "my-project", "match": ["my-project-*-g??", "my-project-* (g??)"] }
```

Rules:

- **Removed on the server.** The server drops the sessions before it builds anything else, so the browser never receives them. They are gone from the sessions list, floors, activity and status counts, relations (every relation that touches one is dropped) and conflicts, whatever the activity filter says.
- **Sub-agents go with their session.** A session spawned natively by an excluded session is excluded too, and so on down the tree, unless another session that stays also spawned it or a supplement file lists it.
- **A pattern is tried against the current name only, not against aliases.** An alias is an older or another name: a session that was retired as `x-g01` and revived under its old name `x` still has `x-g01` as an alias and must not vanish. Use `*-g??` style patterns for observed older generations that the supplement does not list.
- **A listed session wins over a pattern.** A session that a supplement lists in `sessions` without `archived: true` is never left out by a pattern (the same precedence as a listed group member over a group pattern), as long as its listed name is still the session's observed name. To leave a listed session out, mark it `archived: true`.
- **Unlisted sessions.** With `unlisted: true` the session list a supplement file gives (`sessions`) is the whole truth for the named project: an observed session of that project that no supplement file lists is left out, and so are its sub-agents. The only thing that spares it is being spawned (natively, through `spawn` relations, directly or through spawned sessions) by a listed session that stays; its name or a group pattern does not. A listed session that is itself left out (`archived`, `match`) takes its sub-agents with it, but a listed session spawned by an excluded one stays. Without the project limit the setting would hide every other project's sessions, so `project` is required (use `*` to mean all).
- **Several files add up.** `archived` is on when any file turns it on, and the patterns of all files are used.
- **Diagnostic.** When anything is left out the server adds one `info` diagnostic, `supplement-exclude`, with the counts (sessions marked archived, sessions matched by name, sessions outside the session map when `unlisted` is on, sub-agents) and, in its `excluded` list (at most 200 entries), the id, name and reason of each directly excluded session.
- **Without `exclude`** nothing changes: no session is left out and the snapshot carries no such diagnostic.

## Tests

```sh
npm test
npm run verify:live
```

`npm test` runs against synthetic home directories without touching your real records. It covers incremental collection, deletion and replacement, account assignment, a 12,000-level hierarchy, relation conflicts, inactive separation, HTTP security and SSE. It also checks that the English and Korean message catalogs match. Temporary directories created by the tests are removed when they finish.

`npm run verify:live` reads your real session records, read-only, and prints only metadata counts (never transcript bodies). The numbers vary with whichever sessions are active at the time you run it.

## License

[MIT](LICENSE)
