# Changelog

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
