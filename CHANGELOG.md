# Changelog

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
