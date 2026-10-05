// Live view of Claude's browser in an editor tab: attaches to the same Chrome page over the DevTools protocol,
// shows its screencast and passes your clicks, scrolling and typing back, so you can watch or take over.
const vscode = require("vscode");
const fs = require("fs");

const views = new Map(); // state file -> panel

function showBrowser(state) {
  const open = views.get(state);
  if (open) return open.reveal(undefined, true);
  let info;
  try { info = JSON.parse(fs.readFileSync(state, "utf8")); } catch { return vscode.window.showInformationMessage("Claude hasn't opened the browser in this chat yet."); }
  const panel = vscode.window.createWebviewPanel("bitsmith.browser", "Claude's Browser", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon("globe");
  views.set(state, panel);
  const ws = new WebSocket(info.ws); // VS Code's Node has it; a webview can't connect itself (Chrome rejects its origin)
  let seq = 0, history = 0;
  const send = (method, params = {}) => { if (ws.readyState === 1) ws.send(JSON.stringify({ id: ++seq, method, params })); return seq; };
  ws.onopen = () => {
    send("Page.enable");
    history = send("Page.getNavigationHistory");
    send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200 });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data), post = (msg) => panel.webview.postMessage(msg);
    if (m.method === "Page.screencastFrame") {
      send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
      post({ frame: m.params.data, w: m.params.metadata.deviceWidth, h: m.params.metadata.deviceHeight });
    } else if (m.method === "Page.frameNavigated" && !m.params.frame.parentId) post({ url: m.params.frame.url });
    else if (m.id === history && m.result) post({ url: m.result.entries[m.result.currentIndex]?.url });
  };
  ws.onerror = () => {};
  ws.onclose = () => panel.webview.postMessage({ closed: true });
  panel.webview.onDidReceiveMessage((m) => {
    if (m.mouse) send("Input.dispatchMouseEvent", m.mouse);
    else if (m.key) send("Input.dispatchKeyEvent", m.key);
    else if (m.nav === "back") send("Runtime.evaluate", { expression: "history.back()" });
    else if (m.nav === "reload") send("Page.reload");
  });
  panel.onDidDispose(() => { views.delete(state); try { ws.close(); } catch {} });
  panel.webview.html = page();
}

function page() {
  const nonce = require("crypto").randomUUID();
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); color: var(--vscode-foreground); font: 12px var(--vscode-font-family); }
#bar { display: flex; gap: 4px; align-items: center; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
#bar button { background: none; border: 0; color: inherit; cursor: pointer; padding: 2px 6px; border-radius: 3px; }
#bar button:hover { background: var(--vscode-toolbar-hoverBackground); }
#url { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
#wrap { flex: 1; position: relative; overflow: hidden; }
img { position: absolute; inset: 0; margin: auto; max-width: 100%; max-height: 100%; outline: none; cursor: default; }
img:focus { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
</style></head><body>
<div id="bar"><button id="back" title="Back">&#8592;</button><button id="reload" title="Reload">&#8635;</button><span id="url">Connecting…</span></div>
<div id="wrap"><img id="img" tabindex="0" draggable="false" alt=""></div>
<script nonce="${nonce}">
const vs = acquireVsCodeApi(), img = document.getElementById("img"), url = document.getElementById("url");
let w = 0, h = 0, moved = 0;
addEventListener("message", ({ data: m }) => {
  if (m.frame) { img.src = "data:image/jpeg;base64," + m.frame; w = m.w; h = m.h; }
  if (m.url) url.textContent = m.url;
  if (m.closed) url.textContent = "The browser closed. Show it again after Claude reopens it.";
});
document.getElementById("back").onclick = () => vs.postMessage({ nav: "back" });
document.getElementById("reload").onclick = () => vs.postMessage({ nav: "reload" });
const at = (e) => { const r = img.getBoundingClientRect(); return { x: (e.clientX - r.left) * w / r.width, y: (e.clientY - r.top) * h / r.height }; };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS = ["left", "middle", "right"];
const mouse = (type, e, extra) => w && vs.postMessage({ mouse: { type, ...at(e), modifiers: mods(e), ...extra } });
img.onmousedown = (e) => { img.focus(); e.preventDefault(); mouse("mousePressed", e, { button: BUTTONS[e.button], clickCount: e.detail }); };
img.onmouseup = (e) => mouse("mouseReleased", e, { button: BUTTONS[e.button], clickCount: e.detail });
img.onmousemove = (e) => { if (Date.now() - moved > 50) { moved = Date.now(); mouse("mouseMoved", e, { button: e.buttons & 1 ? "left" : "none", buttons: e.buttons }); } };
img.addEventListener("wheel", (e) => { e.preventDefault(); mouse("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }); }, { passive: false });
img.oncontextmenu = (e) => e.preventDefault();
const key = (type, e) => {
  e.preventDefault();
  const text = type === "keyUp" ? "" : e.key === "Enter" ? "\\r" : e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : "";
  vs.postMessage({ key: { type: type === "keyUp" ? type : text ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, text, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode, modifiers: mods(e) } });
};
img.onkeydown = (e) => key("keyDown", e);
img.onkeyup = (e) => key("keyUp", e);
</script></body></html>`;
}

module.exports = { showBrowser };
