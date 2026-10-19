# Changelog

## 1.17.0

- **Open Chat in Terminal.** A terminal button in the chat's title bar (sidebar and editor tab) resumes the same chat
  in the Claude Code CLI (`claude --resume <id>`) in a VS Code terminal. It asks you to stop a running reply first.

## 1.16.0

- **Pinned chats.** Pin up to 5 chats (per folder) from the pin button on a Recent chats row or in Chat History.
  They show in a "Pinned" section above Recent chats on the empty screen; click the pin again to unpin.

## 1.15.0

- **Undo just one step.** An edit step's diff has an "Undo" button: it puts the file back to how it was before that
  step only, keeping later edits. It refuses if the file has moved on so the step can't be reversed exactly, or if
  the file has unsaved changes.
- **Clickable search results.** Grep and Glob steps fold out to a list of matches; a click opens the file at that line.
- **Step durations.** Steps that took a second or more show how long, e.g. "Ran tests · 14.2s".
- **Colored command output.** ANSI colors and bold in Bash output show as in a terminal; other escape codes are stripped.
- **"Changed N files" at the end of a reply.** A click opens everything that reply changed in one multi-file diff.
- **Find in chat (Ctrl+F / Cmd+F).** Highlights every match, Enter / Shift+Enter to move between them, Escape to
  close. Loads the rest of a paged chat so the search covers all of it.
- **Minimap.** Small ticks beside the scrollbar mark your messages, edits, errors and approval cards; click to jump.
- **Show the step that changed a file.** In "files changed", a new button scrolls to the last step that edited it.
- **Edit approvals show the diff inline** on the card, instead of opening a diff editor.
- **Unsaved-file warning.** An edit to a file with unsaved changes in VS Code always asks first, whatever the policy.

## 1.14.0

- **Paged chat loading.** A reopened chat renders only its last 8 messages; scrolling near the top (or a panel
  too short to scroll) fetches 10 earlier ones at a time, slipped in above without moving what's on screen.

## 1.13.2

- **Fix: a compacted chat reopened showing only what came after the compaction.** When Claude Code forks a
  compacted session (a rewind, an edited message, a background compaction), the new session starts at the
  compaction and copies nothing before it. Replay now follows the compaction summary back to the session it came
  from, recursively, so the whole conversation shows again from its first message.

## 1.13.1

- **Fix: clicking a Read step's file opened it at the top.** A chip like "extension.js 425-450" now opens the
  file with exactly the lines Claude read selected, scrolled into view.

## 1.13.0

- **Edit and Write steps fold out to their diff.** Click the chevron on an "Edited" or "Wrote" row to see what that
  step changed: the hunks with two lines of context, syntax colored, VS Code-style red/green rows, and the changed
  part of each modified line marked. Works for past chats too.
- **Open any step's change in VS Code.** "Open in VS Code" (or a click on the diff) opens VS Code's diff editor for
  just that step. The left side is the current file with that step undone, so later edits don't get mixed in; the
  right side is the real file, so you can edit it there. If the file has moved on too far, it diffs the replaced
  text against the new text instead.

## 1.12.5

- **Loading screen fills the panel.** The skeleton sat at the top with empty space below it. Now it fills the
  whole height, anchored to the bottom like a chat scrolled to its latest message, and fades out toward the top.

## 1.12.4

- **Compaction now runs in the background.** 1.12.3 compacted right after the reply, but it still blocked the chat
  until it finished. Now a second Claude Code process forks the session and runs `/compact` on the copy, so you
  can keep reading and typing. When it's done and you haven't sent anything since, the chat continues in the
  compacted copy and shows "Conversation auto-compacted". A message sent while it's still running waits for it
  ("Compacting conversation…") instead of going to the long conversation. A long reply that fills the context
  partway through still has to compact in place: the CLI can't continue without it.

## 1.12.3

- **Compaction no longer makes you wait.** The CLI only compacted when your next message started, so a long
  chat would stall right as you sent it. Now, when a reply ends at 85% or more of the auto-compact point, Bitsmith
  compacts straight away, while you're still reading. Anything you type in the meantime is queued and sent as
  soon as it's done. It runs at most once in a row, never while messages are queued, and not when auto-compact
  is off.

## 1.12.2

- **Fix: a question card could still be changed after you answered it.** Submit only swapped the buttons for
  "Answered"; the choices stayed clickable. Answered, skipped and cancelled cards now freeze: your pick stays
  highlighted, the rest dim and can't be clicked (the plan card's feedback box too).

## 1.12.1

- **Loading screen redesigned and fixed.** It looked washed out: its fade-in froze half transparent while the
  webview was busy drawing the chat. Now: a VS Code-style progress line at the top, the chat title with a spinner,
  and a pulsing sketch shaped like the chat's own message bubbles, at full brightness.

## 1.12.0

- **Loading screen when you open a past chat.** Long chats take a few seconds to read and draw; the pane now shows
  the chat's title, a moving progress bar and a sketch of the conversation right away, instead of sitting blank.
  Sending is held until the chat is there.

## 1.11.7

Low bug fixes:
- **Restoring a chat's first message shows the start screen** instead of a blank pane (the hero could be left in
  another chat's pane).
- **Cancelling the Retry confirmation no longer closes an inline edit** you have open on that message.
- **Undoing a file Claude created deletes it** (hunk Undo left an empty file), and an empty created file now shows
  up for review.
- **Restore puts back a binary file Claude overwrote with Write** byte for byte; it was snapshotted as text.
- **The browser tool no longer leaves a temp folder behind when Chrome isn't installed.**

## 1.11.6

Medium bug fixes:
- **Switching chats with the @ or / menu open no longer sends the pick to the other chat.**
- **Opening a past chat turns "Allow all edits" off**, so its edits ask again.
- **Mode and model changes in an editor-tab chat apply to that chat**, not the sidebar one.
- **Pasted text stays as typed.** It only becomes file chips when every line is a path that exists; text that
  only looks like paths (`// comments`, `'/api/v1'`) is no longer trimmed or stripped.
- **Pasting spreadsheet cells keeps the text** instead of only the image the clipboard also holds.
- **IME composition:** Enter that confirms composed text no longer picks a menu item or sends.
- **A chat replying in the background keeps its "Working…" spinner below the reply text.**
- **Tools panel:** env/header lines without `=`/`:` are rejected instead of getting a wrong key; editing an MCP
  server keeps extra fields (`oauth`, `headersHelper`, …); "Permissions file" creates `settings.local.json` if
  needed; the permission hint now says deny beats ask beats allow.
- **Browser:** tool calls fail with "The browser tab was closed" instead of hanging when the tab or Chrome closes;
  closing the tab reuses the running Chrome (a new tab) instead of starting a second one that could lose its
  profile; the live view reconnects after the browser restarts.

## 1.11.5

Serious bug fixes:
- **Restore and Undo no longer delete files a command `git add`ed.** A file that was untracked before the command
  wasn't in the git snapshot, so it read as "created by the command" and got deleted. It's now left alone.
- **Your own edits during a reply are no longer reverted by Restore.** Command changes are recorded per command
  (just before and after it ran), not across the whole reply, so files you save or create meanwhile aren't touched.
- **A restore sticks even if the CLI restarts before your next message** (switching chats, changing a setting,
  Open in editor, a crash). Before, Claude resumed the full conversation, including the removed messages.
- **Redo after two restores in a row resumes the right point.**
- **Undo all on a file with unsaved edits asks first** instead of silently discarding them.
- **Clicking Keep/Undo on two hunks quickly no longer corrupts the file.** The second click used line numbers from
  before the first; each lens now finds its hunk by content.
- **Removed the temporary drag-and-drop debug log** (`/tmp/bitsmith-drag.log`).

## 1.11.4

- **Fix: the same chat showed many times in history.** Retry, Restore and Edit continue a chat in a copy of its
  session file, and a chat continued after compaction starts a new file; history listed each one. It now shows
  one entry per chat, its newest file. Searching inside chats still finds the older copies.

## 1.11.3

- **Fix: a compaction in the middle of a reply split it in two.** In a reopened chat the "Conversation
  auto-compacted" line ended the reply, so its first half got its own Retry and Undo buttons. It now stays one reply,
  and a compaction between replies sits below the previous reply's buttons.

## 1.11.2

- **Fix: clicking an image named in a reply did nothing.** Files now open with VS Code's own opener, so images show
  in the image preview (and other binaries in their viewer) instead of failing as text.
- **Files outside the workspace open too.** When a reply names just `board.png` and it isn't in the workspace (say,
  a screenshot saved in /tmp), Bitsmith looks next to the paths this chat's tools used.

## 1.11.1

- **Images and other binary files in "files changed" show their size, not fake line counts.** A PNG used to show
  as "+689 -0" because its bytes were split on newlines. Now it reads "new · 142 KB", "96 KB → 118 KB" or
  "deleted · 2 KB", the header counts them apart ("· 3 binary"), and the diff button opens VS Code's side-by-side
  image diff. No line highlights or CodeLens on them.
- **Fix: Undo could corrupt a changed binary file.** Its snapshot was kept as text; it's now kept as bytes, so
  Undo puts back the exact original. Binary files a command changes are now in the list too (they used to be left out).

## 1.11.0

- **Suggested next message**, like the Claude Code terminal. After a reply, Claude's guess at what you'll ask next
  shows greyed out as the input's placeholder; press **Tab** in the empty box to take it, then edit or send. Each chat
  keeps its own, and it goes away when a new reply starts. It appears from the second reply on, and not in plan mode.

## 1.10.3

- **Middle-click closes a chat tab**, like editor tabs (same as its × button).

## 1.10.2

- **Fix: Retry sent the message again.** Retry now rewinds to just before that message and runs it again in
  place, replacing the old reply, instead of adding a duplicate message at the end. It asks first only if file
  changes would be reverted or later messages removed.

## 1.10.1

- **Fix: every chat showed the same "files changed" list.** Each chat now lists only the files it changed, and its
  **Keep** / **Undo** (and the Keep All / Undo All commands, for the chat on screen) only touch those files. A file
  two chats both changed shows in both. Kept or undone, it leaves both lists.
- **Fix: the input box was shared by all chats.** Typed text, attached files and folders, pasted images and the
  current-file toggle now belong to each chat. Switching tabs keeps each chat's unsent message, and Restore or Redo
  in a background chat fills that chat's input, not the one on screen.

## 1.10.0

- **Auto-compact at 200k:** a new setting, **Bitsmith: Auto Compact At** (150k / 200k / 300k / 500k / Claude Code
  default / Off; default 200k). The CLI already compacts on its own, but only near the model's limit (about 967k of
  1M), so in practice it never happened and long chats were compacted by hand. Bitsmith now passes
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, so 200k compacts at about 167k; Off passes `DISABLE_AUTO_COMPACT`. Running chats
  switch on their next message.
- **Faster compaction:** `precomputeCompactionEnabled` is on (through `--settings`), so the summary is mostly ready
  when it's needed.
- **Context meter:** the ring fills toward the auto-compact point (from the CLI's `get_context_usage`), and the
  tooltip says where it compacts, or that auto-compact is off.
- **"Conversation auto-compacted"** notices tell automatic compactions apart from manual ones, live and in history.
- **Fix: Restore and Edit message to a message before a compaction** (automatic or manual) silently did nothing. The
  CLI can't resume at a message from before a compaction ("No message found with message.uuid"). Bitsmith now
  branches from a copy of the transcript cut at that message. CLI errors like this one are now shown instead of
  swallowed.

## 1.9.0

- **MCP & Skills panel** (🔌 in the chat title bar) replaces the 1.8.0 picker. An editor tab with two tabs:
  - **MCP servers:** status, scope, type, version and tool count for each server, with an on/off switch.
    - **Add / Edit / Remove** servers with a form: command, arguments and env for stdio, or URL and headers for
      HTTP/SSE, saved for this folder, the project's `.mcp.json`, or all folders. It runs `claude mcp add-json` and
      `claude mcp remove`, then restarts idle chats so they load the change. A failed edit puts the old server back.
    - **Sign in / Sign out** for HTTP/SSE servers (`mcp_authenticate` opens the browser; `mcp_clear_auth`).
    - **Why it failed:** the server's error, plus a hint for common causes (command not on PATH, refused
      credentials, timeout, nothing listening, waiting for approval), with a Retry button.
    - **Permissions:** expand a server to see its tools, with read-only and destructive tags. Set Allow, Always ask
      or Block for one tool or the whole server. The rules go to `permissions` in `.claude/settings.local.json`,
      and running chats apply them at once.
  - **Skills:** each skill gets On, Name only, Only when I type /name, or Off (`skillOverrides`). A token budget
    shows what skill listings cost every chat and what the current levels save. There's a filter box.

## 1.8.0

- **Edit plan:** the plan approval card has an **Edit plan** button that opens the plan as a Markdown file. Approve,
  and Claude builds the edited plan (the CLI sends it as "Approved Plan (edited by user)"). With **Keep planning**,
  the edits go back to Claude as feedback. The temp file is removed afterwards.
- **MCP Servers & Skills** (title-bar `…` menu, or the command palette): a picker with each MCP server (status and
  scope) and skill (source and token cost), ticked when on. Servers toggle through the CLI's `mcp_toggle` (saved per
  project in `~/.claude.json`); failed or needs-auth servers have a Reconnect button. Skills toggle through
  `skillOverrides` in the folder's `.claude/settings.local.json`, then `reload_skills`. Changes apply to every running chat.

## 1.7.2

- Pasting a file or folder path (absolute, `~/`, relative to the workspace or `file://`, one per line) into the
  input attaches it as a file/folder chip. Paths that don't exist are pasted as plain text.

## 1.7.1

- Fix: files dropped (Shift+drag) or picked with + in a chat open in an editor tab were sent to the sidebar
  instead; they now land in that tab's input.

## 1.7.0

- Changes made by shell commands (`sed -i`, `python … open().write`, `cat > file`, `rm`, …) are now reviewable and
  undoable exactly like Edit/Write: they show under "files changed", get Keep/Undo in the panel and in the editor,
  and Restore checkpoint reverts them. Claude Code calls Bitsmith right before each command (a PreToolUse hook), and
  Bitsmith takes a git snapshot of every repo the command may touch, including nested repos the folder's
  `.gitignore` excludes. Not covered: untracked files that already existed, ignored files, and folders outside git.

## 1.6.4

- Up / Down recall also covers the messages of the chat on screen, so it works in chats reopened from history.

## 1.6.3

- Up / Down in the chat box recalls your earlier prompts, like a shell. Up works from the first line and Down
  from the last, so multi-line edits are unaffected; Down past the newest brings back what you were typing.

## 1.6.2

- A smaller, quieter chat box toolbar, like Copilot's: compact Mode / Model / Effort / Approvals labels without
  chevrons or extra icons, and the send arrow stays muted until you type.

## 1.6.1

- Bitsmith tabs open in a split beside your code, like Claude Code, instead of covering the file you're on. More
  Bitsmith tabs join that same group.

## 1.6.0

- Open Bitsmith straight into the editor area: a Bitsmith icon in every editor's title bar opens a new chat in a
  tab (**Bitsmith: Open in New Tab**).
- Editor-tab chats get their own header inside the tab, like Claude Code's: chat title (double-click to rename),
  History, New Chat, and Rename, Plan usage, Export and Delete under "…". The buttons in VS Code's title bar for
  these tabs are gone.

## 1.5.9

- Chats in editor tabs: **Open Chat in Editor** also works on a new chat (it opens an empty one in a tab), and
  there's **Bitsmith: New Chat in Editor**. The tab's title bar has New Chat, History and Usage, plus Rename, Delete
  and Export under "…"; they act on that tab. History and Recent chats open into the tab (or a new tab) instead of
  the sidebar. Tabs reopen with their chat after a window reload instead of staying blank.

## 1.5.8

- Recent chats on the empty chat screen now include chats started in this window. The list was only read when the
  window opened (and after a rename or delete), so new chats seemed not to be saved until a reload.

## 1.5.7

- Live view of Claude's browser: a "Claude's Browser" tab streams the page and passes your clicks, scrolling and
  typing back, with Back and Reload. It opens by itself in headless mode; **Bitsmith: Show Claude's Browser**
  opens it any time.
- `bitsmith.browserKeepLogins`: keep cookies and logins between chats in a Bitsmith-only Chrome profile. If
  another chat has it open, the new one uses a throwaway profile. Chrome now closes cleanly so cookies are saved.

## 1.5.6

- Browser tools (setting `bitsmith.browser`: `off`, `window` or `headless`): Claude can open pages in its own Chrome,
  read them, click, type, press keys, take screenshots and read the console. A small built-in MCP server over the
  Chrome DevTools Protocol, no new dependencies; a throwaway profile is removed when the chat ends. On Wayland
  the window uses X11, and the VS Code snap's library paths are kept away from Chrome.

## 1.5.5

- Plan usage stays current: it refreshes from your Claude account every 2 minutes while the window is focused,
  when the window regains focus and when you open the card, so usage from other Claude sessions shows up.
  The card has a refresh button, and "Updated … ago" keeps ticking while it's open.

## 1.5.4

- README: logo, badges, screenshots and a highlights table. Screenshots live in `docs/`; build with
  `--no-rewrite-relative-links` so they show on GitHub and in the Extensions view.

## 1.5.3

- Clicking a file named in a reply opens it even when the path isn't from the folder root: it searches the
  workspace, prefers a file this chat touched, and asks when several match.

## 1.5.2

Security hardening. No features removed.

- `bitsmith.claudePath` and `bitsmith.defaultPolicy` are now machine-scoped, so a folder's
  `.vscode/settings.json` can no longer choose which binary Bitsmith launches or turn approvals off.
- Workspace Trust is declared explicitly: Bitsmith stays off in Restricted Mode.
- Edits that can make something else run commands later always ask, whatever the approval policy says:
  anything under `.git/`, `.claude/`, `.vscode/`, `.husky/`, `.devcontainer/` or `.github/workflows/`, shell startup files (`.bashrc`, `.zshrc`, `.profile`, …),
  and any write outside the workspace folder apart from scratch files in the temp dir. Symlinks are followed, so a
  link inside the folder can't point at `~/.bashrc`. The card says why it asked, and "Allow all edits" doesn't cover these.
  Ordinary edits inside the folder are unchanged: `review` still applies them straight away with Keep / Undo.
- Webview nonce comes from `crypto.randomUUID()` instead of `Math.random()`.
- Only `http(s):` and `mailto:` links in replies are clickable; anything else (`javascript:`, `data:`, `command:`, `file:`, …) renders as plain text.
- Fixed an HTML injection through file chips in inline code (the `:line` part is now digits only).
- Fixed: the Session and Weekly bars in the plan usage card never filled. Their width came from a `style`
  attribute, which the webview's CSP drops; it now goes through CSSOM like the composer's context ring does
  (`h()` also sets any `style` prop through CSSOM now).

Bug fixes from a review of the extension and the webview:

- Restore could delete files changed by commands once `git gc` had pruned their snapshot; those are skipped now.
- Output a killed CLI still had buffered could restart a reply that never ended, leaving the chat busy for good.
- Approval cards are cancelled only when the host drops the request (restart, exit, interrupt), not when a turn
  folds, so a background agent's approval no longer hangs.
- Command changes are recorded on the right checkpoint when a queued message goes out straight away.
- Restore no longer cuts down the original session's checkpoints, and re-checks for a reply started while its
  dialog was open.
- Opening a history chat that's in an editor tab reveals that tab; closing the sidebar no longer ends editor-tab chats.
- `loadSession` resets the redo stack; stdin EPIPE is handled; the commit message times out after 2 minutes;
  a rejected new-file write leaves no "deleted" row; edit approval cards notify like command ones.
- Webview: "Send now" can't fire mid-reply; Enter on a button inside a row no longer triggers the row; an edited
  message can't be sent twice; the `@` list clears after sending; `/` before commands load no longer breaks Enter;
  inline code shows entity text literally; restore/redo in a hidden chat doesn't overwrite the visible composer;
  switching to a busy or unread tab scrolls to the newest message.
