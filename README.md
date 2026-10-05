# Bitsmith

A Copilot-style coding agent for VS Code's secondary sidebar, powered by your local Claude Code CLI and its login (skills, hooks, CLAUDE.md and sessions are shared with the CLI).

- Context: the current file (and selection) is suggested automatically; add files and folders with +, Shift+drag from the Explorer, or right-click → Add to Bitsmith Chat
- Model, effort, Agent/Plan mode and approval policy pickers
- Live steps (reads, searches, edits with +/- counts, commands), thinking, todos
- Copilot-style edit review: Keep / Undo per hunk in the editor, per file or all in the chat
- Approval cards for commands, plans and questions; paste images; slash commands; chat history

Test: `node test/e2e.js` from an empty folder (uses the real CLI).
