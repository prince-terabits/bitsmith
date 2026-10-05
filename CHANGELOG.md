# Changelog

## 1.5.2

Security hardening. No features removed.

- `bitsmith.claudePath` and `bitsmith.defaultPolicy` are now machine-scoped, so a folder's
  `.vscode/settings.json` can no longer choose which binary Bitsmith launches or turn approvals off.
- Workspace Trust is declared explicitly: Bitsmith stays off in Restricted Mode.
- Edits that can make something else run commands later always ask, whatever the approval policy says:
  anything under `.git/`, `.claude/` or `.vscode/`, shell startup files (`.bashrc`, `.zshrc`, `.profile`, …),
  and any write outside the workspace folder apart from scratch files in the temp dir. The card says why it asked.
  Ordinary edits inside the folder are unchanged: `review` still applies them straight away with Keep / Undo.
- Webview nonce comes from `crypto.randomUUID()` instead of `Math.random()`.
- Markdown links with a `javascript:`, `data:` or `vbscript:` scheme render as plain text; other links are unchanged.
- Fixed: the Session and Weekly bars in the plan usage card never filled. Their width came from a `style`
  attribute, which the webview's CSP drops; it now goes through CSSOM like the composer's context ring does.
