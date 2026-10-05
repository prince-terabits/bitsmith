const vscode = acquireVsCodeApi();
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "style") el.style.cssText = v; // the CSP blocks style attributes, not CSSOM
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  if (tag === "button" && props.title && !props["aria-label"] && !el.textContent.trim()) el.setAttribute("aria-label", props.title); // icon-only buttons
  return el;
}
const icon = (name, cls = "") => h("i", { class: `codicon codicon-${name} ${cls}` });
const logo = (cls = "") => h("i", { class: `bs-logo ${cls}`, "aria-hidden": "true" });
const base = (p) => p.split("/").filter(Boolean).pop() || p;
const dir = (p) => p.split("/").slice(0, -1).join("/");
const send = (msg) => vscode.postMessage({ chat: cur?.key, ...msg }); // the chat on screen, or the one a queued message belongs to

// ---------- markdown ----------
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FILE_EXT = /\.(jsx?|tsx?|mjs|cjs|py|json|md|css|scss|less|html?|xml|ya?ml|toml|txt|sh|go|rs|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|svelte|sql|ini|cfg|conf|env|lock|csv|svg|png|jpe?g|gif|webp|ipynb|dart|lua|r|scala|gradle)$/i;
const looksLikePath = (s) => s.length < 160 && !/\s/.test(s) && (/^[\w@.~-]*\/[\w@.\/-]+(:\d+)?$/.test(s) || FILE_EXT.test(s.replace(/:\d+$/, "")));
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    code: ({ text, lang }) =>
      `<div class="codeblock"><div class="codebar"><span>${escapeHtml(lang || "")}</span><button class="icon-btn copy-code" title="Copy"><i class="codicon codicon-copy"></i></button></div><pre><code>${highlight(text, lang)}</code></pre></div>`,
    codespan: ({ text }) => {
      const raw = text; // marked passes code text unescaped
      if (looksLikePath(raw)) {
        const [file, ln] = raw.split(":"), line = /^\d+$/.test(ln || "") ? ln : "";
        return `<span class="chip file-link" data-file="${escapeHtml(file)}" data-line="${line}" title="${escapeHtml(raw)}"><i class="codicon codicon-file"></i>${escapeHtml(base(file))}${line ? `:${line}` : ""}</span>`;
      }
      return `<code>${escapeHtml(raw)}</code>`;
    },
    // only web and mail links are clickable; anything else (command:, file:, javascript:) stays plain text
    link: ({ href, text }) => /^(https?:|mailto:)/i.test(href || "") ? `<a href="${escapeHtml(href)}" title="${escapeHtml(href)}">${escapeHtml(text)}</a>` : escapeHtml(text),
  },
});
const md = (text) => marked.parse(text || "");

// Small highlighter for code blocks: comments, strings, numbers, keywords, calls and markup tags. No dependency;
// ponytail: regex tokens, not a grammar. Swap in a real highlighter if a language reads badly.
const KEYWORDS = new Set(("if else elif for while do return function const let var class new this import from export default async await try catch " +
  "finally throw raise def in not and or is None True False lambda with as pass yield self super public private protected static void " +
  "int float double string bool boolean true false null undefined nil typeof instanceof extends implements interface type enum struct " +
  "fn pub use mod match impl where package func go defer case switch break continue then fi done esac local echo select insert update " +
  "delete create table where values set into join on order by group having limit").split(" "));
const HASH_COMMENTS = /^(py|python|sh|bash|zsh|shell|console|yaml|yml|toml|rb|ruby|r|perl|pl|dockerfile|make|makefile|ini|conf|cfg|properties|env)$/i;
function highlight(code, lang = "") {
  if (code.length > 60000 || /^(text|txt|plain|output|log)$/i.test(lang)) return escapeHtml(code);
  const markup = /^(html?|xml|svg|vue|jsx|tsx|qweb)$/i.test(lang);
  const hash = HASH_COMMENTS.test(lang), dashes = /^(sql|lua|haskell|hs)$/i.test(lang);
  // groups: 1 # comment, 2 -- comment, 3 other comments, 4 string, 5 tag, 6 number, 7 call, 8 word
  const re = /(#[^\n]*)|(--[^\n]*)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(<\/?[\w:.-]+)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$-]*)/g;
  let out = "", at = 0, m;
  while ((m = re.exec(code))) {
    const [all, hashC, dashC, c, str, tag, num, call, word] = m;
    if ((hashC && !hash) || (dashC && !dashes) || (tag && !markup)) { re.lastIndex = m.index + 1; continue; } // not a comment/tag in this language
    out += escapeHtml(code.slice(at, m.index));
    at = m.index + all.length;
    const cls = hashC || dashC || c ? "c" : str ? "s" : tag ? "t" : num ? "n" : call ? (KEYWORDS.has(call) ? "k" : "f") : KEYWORDS.has(word) ? "k" : "";
    out += cls ? `<span class="tk-${cls}">${escapeHtml(all)}</span>` : escapeHtml(all);
  }
  return out + escapeHtml(code.slice(at));
}

// ---------- state ----------
const S = {
  models: [], commands: [], model: "default", effort: "", mode: "agent", policy: "review",
  active: null, useActive: true, items: [], images: [], busy: false, last: null, todos: [], changes: [], sessions: [],
};
let turn = null; // the response being streamed into
let nextCheckpoint = 1;
let redo = null; // { stack: [removed nodes, newest last], bar } so Redo can put messages back, one restore at a time

// Open chats. Each has its own pane and turn state; `shown` is on screen, `cur` is the one messages are applied to.
const chats = new Map();
let shown = null, cur = null, scroll = null;
let synced = false; // the extension sent its chats; until then, don't report an (empty) queue over its saved one

// ---------- layout ----------
const tabsBar = h("div", { class: "chat-tabs hidden", role: "tablist" });
const empty = h("div", { class: "empty" });
const recentPanel = h("div", { class: "recent hidden" });
const tasksPanel = h("div", { class: "panel tasks hidden" });
const todosPanel = h("div", { class: "panel todos hidden" });
const changesPanel = h("div", { class: "panel changes hidden" });
const chips = h("div", { class: "chips" });
const input = h("textarea", { rows: 1, placeholder: "Ask Bitsmith to build, fix or explain…" });
const slash = h("div", { class: "menu slash hidden" });
const sendBtn = h("button", { class: "send", title: "Send (Enter)", onclick: () => submit() }, icon("send"));
const stopBtn = h("button", { class: "send stop hidden", title: "Stop", onclick: () => stop() }, icon("debug-stop"));
const queuePanel = h("div", { class: "queue hidden" });
const meterBtn = h("button", { class: "context-meter hidden", onclick: () => compact() });
const modeBtn = h("button", { class: "pill" });
const modelBtn = h("button", { class: "pill" });
const effortBtn = h("button", { class: "pill" });
const policyBtn = h("button", { class: "pill subtle" });
const dropOverlay = h("div", { class: "drop" }, icon("cloud-upload"), h("span", {}, "Drop to attach files, folders or images"));

const box = h("div", { class: "box" },
  dropOverlay, chips, input, slash,
  h("div", { class: "toolbar" }, modeBtn, modelBtn, effortBtn, h("span", { class: "grow" }), meterBtn, sendBtn, stopBtn),
);
const composer = h("div", { id: "composer" }, recentPanel, tasksPanel, todosPanel, queuePanel, changesPanel, box,
  h("div", { class: "footer" }, policyBtn, h("span", { class: "grow" }), h("span", { class: "muted hint", title: "VS Code only lets panels like this one receive drops while Shift is held" }, "/ for commands · hold Shift to drop files")));
$("#app").append(tabsBar, composer);

// ---------- dropdown menus ----------
let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener("mousedown", (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
function menu(anchor, title, options, current, onPick) {
  closeMenu();
  const el = h("div", { class: "menu" }, title && h("div", { class: "menu-title" }, title),
    options.map((o) => h("div", { class: `menu-item ${o.value === current ? "selected" : ""}`, onclick: () => { closeMenu(); onPick(o.value); } },
      h("span", { class: "check" }, o.value === current ? icon("check") : null),
      h("div", { class: "menu-text" }, h("div", {}, o.icon && icon(o.icon), o.label), o.description && h("div", { class: "muted small" }, o.description)))));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(6, Math.min(r.left, window.innerWidth - el.offsetWidth - 6)) + "px";
  el.style.bottom = window.innerHeight - r.top + 4 + "px";
  openMenu = el;
}

const MODES = [
  { value: "agent", label: "Agent", icon: "hubot", description: "Edits files and runs commands" },
  { value: "plan", label: "Plan", icon: "list-ordered", description: "Researches and proposes a plan first, no edits" },
];
const POLICIES = [
  { value: "review", label: "Review edits", icon: "shield", description: "Edits apply now, Keep or Undo later. Commands ask." },
  { value: "ask", label: "Ask before edits", icon: "question", description: "Every edit asks first, with a diff" },
  { value: "bypass", label: "Bypass approvals", icon: "warning", description: "Nothing asks. Edits stay undoable." },
];
const EFFORT_LABEL = { "": "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

function setSetting(key, value) {
  S[key] = value;
  send({ type: "setting", key, value });
  renderToolbar();
}

function currentModel() {
  return S.models.find((m) => m.value === S.model) || { value: S.model, displayName: S.model };
}

function renderToolbar() {
  const mode = MODES.find((m) => m.value === S.mode) || MODES[0];
  modeBtn.replaceChildren(icon(mode.icon), mode.label, icon("chevron-down", "chev"));
  const model = currentModel();
  const name = model.value === "default" && model.description ? model.description.split(" · ")[0] : (model.displayName || model.value);
  modelBtn.replaceChildren(icon("sparkle"), name, icon("chevron-down", "chev"));
  const levels = model.supportedEffortLevels || [];
  effortBtn.classList.toggle("hidden", !levels.length && !S.effort);
  effortBtn.replaceChildren(icon("dashboard"), EFFORT_LABEL[S.effort] || S.effort, icon("chevron-down", "chev"));
  const policy = POLICIES.find((p) => p.value === S.policy) || POLICIES[0];
  policyBtn.replaceChildren(icon(policy.icon), policy.label, icon("chevron-down", "chev"));
  policyBtn.classList.toggle("danger", S.policy === "bypass");
}
modeBtn.onclick = () => menu(modeBtn, "Mode", MODES, S.mode, (v) => setSetting("mode", v));
modelBtn.onclick = () => menu(modelBtn, "Model", (S.models.length ? S.models : [{ value: "default", displayName: "Default" }]).map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })), S.model, (v) => {
  setSetting("model", v);
  const levels = currentModel().supportedEffortLevels || [];
  if (S.effort && !levels.includes(S.effort)) setSetting("effort", "");
});
effortBtn.onclick = () => menu(effortBtn, "Thinking effort", ["", ...(currentModel().supportedEffortLevels || [])].map((v) => ({ value: v, label: EFFORT_LABEL[v] || v, description: v === "" ? "Use the model's default" : null })), S.effort, (v) => setSetting("effort", v));
policyBtn.onclick = () => menu(policyBtn, "Approvals", POLICIES, S.policy, (v) => setSetting("policy", v));

// ---------- context chips ----------
const kindIcon = (k) => (k === "folder" ? "folder" : k === "selection" ? "list-selection" : "file");
function chip(item, { onRemove, suggested, onToggle, off } = {}) {
  const label = base(item.rel) + (item.range ? `:${item.range}` : "");
  return h("span", { class: `chip ${suggested ? "suggested" : ""} ${off ? "off" : ""}`, title: item.rel + (suggested ? " · current file, click the eye to include or exclude it" : "") },
    h("span", { class: "chip-main", onclick: () => send({ type: "open", file: item.file || item.rel }) }, icon(kindIcon(item.kind)), label),
    onToggle && h("button", { class: "icon-btn", title: off ? "Include current file" : "Exclude current file", onclick: onToggle }, icon(off ? "eye-closed" : "eye")),
    onRemove && h("button", { class: "icon-btn", title: "Remove", onclick: onRemove }, icon("close")));
}

// The current file already attached as a chip (dropped, picked or right-clicked) shows once, as the attachment.
function activeIsAttached() {
  const a = S.active;
  return !!a && !a.selection && S.items.some((i) => i.kind === "file" && (i.file === a.file || i.rel === a.rel));
}

function renderChips() {
  const kids = [h("button", { class: "icon-btn attach", title: "Add files & folders (or Shift+drag them here)", onclick: () => send({ type: "pickContext" }) }, icon("add"))];
  if (S.active && !activeIsAttached()) {
    const a = S.active;
    kids.push(chip({ kind: "file", rel: a.rel, file: a.file, range: a.selection ? `${a.selection.start}-${a.selection.end}` : "" }, { suggested: true, off: !S.useActive, onToggle: () => { S.useActive = !S.useActive; renderChips(); } }));
  }
  S.items.forEach((it, i) => kids.push(chip(it, { onRemove: () => { S.items.splice(i, 1); renderChips(); } })));
  S.images.forEach((img, i) => kids.push(imageChip(img, i + 1, () => { S.images.splice(i, 1); hidePreview(); renderChips(); })));
  chips.replaceChildren(...kids);
}

function addItems(items) {
  for (const it of items) if (!S.items.some((x) => x.rel === it.rel && x.kind === it.kind && x.start === it.start)) S.items.push({ ...it, range: it.kind === "selection" ? `${it.start}-${it.end}` : "" });
  renderChips();
  input.focus();
}

// Pasted images sit in the chip row as "Pasted Image" chips, with a large preview on hover.
function imageChip(img, n, onRemove) {
  const el = h("span", { class: "chip image-chip" },
    onRemove && h("button", { class: "icon-btn", title: "Remove image", onclick: onRemove }, icon("close")),
    h("img", { class: "chip-thumb", src: img.url, alt: "" }),
    h("span", { class: "chip-main" }, n > 1 ? `Pasted Image ${n}` : "Pasted Image"));
  el.title = "Open image";
  el.addEventListener("click", (e) => { if (!e.target.closest(".icon-btn")) { hidePreview(); send({ type: "openImage", mediaType: img.mediaType, data: img.data }); } });
  el.addEventListener("mouseenter", () => showPreview(el, img.url));
  el.addEventListener("mouseleave", hidePreview);
  return el;
}

const preview = h("div", { class: "img-preview hidden" }, h("img", { alt: "Pasted image preview" }));
document.body.append(preview);
function showPreview(anchor, url) {
  preview.firstChild.src = url;
  preview.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = preview.offsetWidth, ht = preview.offsetHeight;
  preview.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + "px";
  preview.style.top = (r.top - ht - 6 >= 6 ? r.top - ht - 6 : Math.min(r.bottom + 6, window.innerHeight - ht - 6)) + "px";
}
function hidePreview() {
  preview.classList.add("hidden");
}

function drawThumbs() {
  renderChips();
}

function addImageFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result;
    S.images.push({ mediaType: file.type, data: url.slice(url.indexOf(",") + 1), url });
    drawThumbs();
  };
  reader.readAsDataURL(file);
}

// ---------- input: autosize, paste, slash commands ----------
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
}
let slashIndex = 0;
function slashMatches() {
  const m = input.value.match(/^\/([\w:.-]*)$/);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return S.commands.filter((c) => c.name.toLowerCase().includes(q)).sort((a, b) => a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)).slice(0, 8);
}
function renderSlash() {
  if (mention) return renderMention();
  const list = slashMatches();
  slash.classList.toggle("hidden", !list.length);
  slashIndex = Math.max(0, Math.min(slashIndex, list.length - 1));
  slash.replaceChildren(...list.map((c, i) => h("div", { class: `menu-item ${i === slashIndex ? "active" : ""}`, onmousedown: (e) => { e.preventDefault(); pickSlash(c); } },
    h("div", { class: "menu-text" }, h("div", {}, h("b", {}, "/" + c.name), c.hint ? h("span", { class: "muted" }, " " + c.hint) : null), c.description && h("div", { class: "muted small ellipsis" }, c.description.replace(/\s*\((user|project|plugin.*)\)$/, ""))))));
}
function pickSlash(c) {
  input.value = `/${c.name} `;
  renderSlash();
  input.focus();
}
// "@" mentions: matching files come from the extension and are picked into chips, like the + picker.
let mention = null; // { q, items, index } while the caret sits after "@query"
let mentionTimer;
function updateMention() {
  const m = input.value.slice(0, input.selectionStart).match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) { mention = null; return; }
  mention = { q: m[1], items: [], index: 0 }; // never pick a result of the previous query
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => send({ type: "fileSearch", q: m[1] }), 80);
}
function pickMention(item) {
  const pos = input.selectionStart, before = input.value.slice(0, pos).replace(/@[^\s@]*$/, "");
  input.value = before + input.value.slice(pos);
  input.setSelectionRange(before.length, before.length);
  mention = null;
  renderSlash();
  autosize();
  addItems([item]);
}
function renderMention() {
  const list = mention.items;
  slash.classList.toggle("hidden", !list.length);
  slash.replaceChildren(h("div", { class: "menu-title" }, "Attach a file"), ...list.map((f, i) => h("div", { class: `menu-item ${i === mention.index ? "active" : ""}`, onmousedown: (e) => { e.preventDefault(); pickMention(f); } },
    icon("file"), h("div", { class: "menu-text ellipsis" }, h("span", {}, base(f.rel)), h("span", { class: "muted small" }, "  " + dir(f.rel))))));
}

input.addEventListener("input", () => { autosize(); slashIndex = 0; updateMention(); renderSlash(); });
input.addEventListener("keydown", (e) => {
  if (mention?.items.length) {
    const n = mention.items.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mention.index = (mention.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n; return renderMention(); }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return pickMention(mention.items[mention.index]); }
    if (e.key === "Escape") { mention = null; return renderSlash(); }
  }
  const list = slashMatches();
  if (list.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; return renderSlash(); }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); return pickSlash(list[slashIndex]); }
    if (e.key === "Escape") { input.value = ""; return renderSlash(); }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
input.addEventListener("paste", (e) => {
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith("image/")) continue;
    e.preventDefault();
    addImageFile(item.getAsFile());
  }
});

// ---------- drag & drop ----------
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; box.classList.add("dragging"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; box.classList.remove("dragging"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  box.classList.remove("dragging");
  const uris = await droppedUris(e.dataTransfer);
  if (uris.length) return send({ type: "drop", uris });
  for (const f of e.dataTransfer.files) if (f.type.startsWith("image/")) addImageFile(f);
});

// VS Code hands Explorer/editor drags to webviews as "resourceurls" (JSON array of file:// URIs)
// or "codeeditors" (JSON array of { resource }); the standard uri-list types are a fallback.
async function droppedUris(dt) {
  const read = (item) => new Promise((res) => item.getAsString(res));
  const out = new Set();
  for (const item of [...dt.items]) {
    if (item.kind !== "string") continue;
    const type = item.type.toLowerCase();
    if (!["resourceurls", "codeeditors", "application/vnd.code.uri-list", "text/uri-list"].includes(type)) continue;
    const text = await read(item);
    try {
      if (type === "resourceurls") JSON.parse(text).forEach((u) => typeof u === "string" && out.add(u));
      else if (type === "codeeditors") JSON.parse(text).forEach((ed) => { const r = ed?.resource; const u = r?.external || (r?.fsPath && "file://" + r.fsPath); if (u) out.add(u); });
      else text.split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith("#")).forEach((u) => out.add(u));
    } catch {}
  }
  return [...out].filter((u) => u.startsWith("file:"));
}

// ---------- conversation ----------
function scrollDown(force) {
  const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  if (force || near) scroll.scrollTop = scroll.scrollHeight;
}

function showEmpty(on) {
  if (cur !== shown) return; // the hero and recent chats belong to the chat on screen
  empty.classList.toggle("hidden", !on);
  showRecent();
}

function renderEmpty() {
  empty.replaceChildren(h("div", { class: "hero" },
    h("div", { class: "logo" }, logo()),
    h("h2", {}, "Bitsmith"),
    h("p", { class: "muted" }, "Build, fix and explain code with Claude Code."),
    h("div", { class: "hints muted small" },
      h("span", {}, icon("add"), "attach files"), h("span", {}, icon("symbol-event"), "/ commands"), h("span", {}, icon("diff"), "Keep or Undo edits"))));
  recentPanel.replaceChildren(
    h("div", { class: "recent-head" }, h("span", { class: "section-title" }, "Recent chats"), h("span", { class: "grow" }),
      h("button", { class: "link-btn", onclick: () => send({ type: "history" }) }, "View all")),
    ...S.sessions.slice(0, 5).map((s) => h("div", { class: "recent-item", role: "button", tabindex: "0", title: s.title, onclick: () => send({ type: "loadSession", id: s.id }) },
      icon("comment-discussion"), h("span", { class: "ellipsis" }, s.title), h("span", { class: "muted small time" }, ago(s.time)),
      h("button", { class: "icon-btn delete-chat", title: "Delete chat", "aria-label": `Delete chat: ${s.title}`, onclick: (e) => { e.stopPropagation(); send({ type: "deleteSession", id: s.id }); } }, icon("trash")))));
  showRecent();
}

function showRecent() {
  if (cur !== shown) return;
  recentPanel.classList.toggle("hidden", !S.sessions.length || !!scroll.querySelector(".turn"));
}

function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  for (const [n, u] of [[86400 * 30, "mo"], [86400 * 7, "w"], [86400, "d"], [3600, "h"], [60, "m"]]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
}

function userBubble({ text, chips: c = [], images = [] }, checkpoint) {
  const textEl = h("div", { class: "user-text" }, text);
  const bubble = h("div", { class: "user-msg" },
    checkpoint && h("button", { class: "icon-btn edit-btn", title: "Edit message", onclick: () => editMessage(bubble, textEl, checkpoint) }, icon("edit")),
    c.length || images.length ? h("div", { class: "chips" }, c.map((x) => chip(x)), images.map((img, i) => imageChip(img, images.length > 1 ? i + 1 : 1))) : null,
    textEl);
  return bubble;
}

// Inline edit: resending restores the checkpoint before this message, then sends the new text.
function editMessage(bubble, textEl, checkpoint) {
  if (S.busy || bubble.classList.contains("editing")) return;
  const original = textEl.textContent;
  const area = h("textarea", { class: "edit-area", rows: 1 });
  area.value = original;
  const done = () => { bubble.classList.remove("editing"); editor.replaceWith(textEl); };
  const save = () => {
    if (S.busy || bubble.classList.contains("pending")) return; // one resend at a time, never mid-reply
    const text = area.value.trim();
    if (!text || text === original) return done();
    bubble.classList.add("pending");
    send({ type: "editMessage", checkpoint, text });
  };
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); done(); }
  });
  area.addEventListener("input", () => { area.style.height = "auto"; area.style.height = area.scrollHeight + "px"; });
  const editor = h("div", { class: "edit-box" }, area,
    h("div", { class: "edit-actions" }, h("span", { class: "muted small grow" }, "Enter to resend · Esc to cancel"),
      h("button", { class: "small", onclick: done }, "Cancel"),
      h("button", { class: "primary small", onclick: save }, icon("send"), "Send")));
  bubble.classList.add("editing");
  textEl.replaceWith(editor);
  bubble.cancelEdit = done;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  area.dispatchEvent(new Event("input"));
}

function startTurn(user, payload) {
  finalize();
  showEmpty(false);
  const el = h("div", { class: "turn" });
  if (payload?.checkpoint) el.dataset.checkpoint = payload.checkpoint;
  if (user) el.append(userBubble(user, payload?.checkpoint));
  else el.classList.add("auto"); // Claude carrying on by itself, e.g. after a background task ended
  const body = h("div", { class: "response" });
  el.append(body);
  scroll.append(el);
  showRecent(); // recent chats only belong on the empty screen
  el.payload = payload;
  turn = { el, body, text: null, steps: new Map(), count: 0, payload, start: Date.now() };
  scrollDown(true);
}

function ensureTurn() {
  if (!turn) startTurn(null);
  return turn;
}

function working(on, label = "Working…") {
  const t = turn;
  if (!t) return;
  t.working?.remove();
  t.working = null;
  t.workingLabel = on ? label : null;
  if (on) { t.working = h("div", { class: "working shimmer" }, icon("loading", "spin"), label); t.body.append(t.working); }
}

// The live thinking row says "Thinking…"; once Claude moves on it settles to "Thought".
function endThinking(t) {
  const label = t.thinking && $(".think-label", t.thinking);
  if (label) { label.textContent = "Thought"; label.classList.remove("shimmer"); }
  t.thinking = null;
}

function addText(text) {
  const t = ensureTurn();
  endThinking(t);
  if (t.workingLabel && t.workingLabel !== "Working…") working(true); // the text itself shows progress now
  if (!t.text) { t.text = h("div", { class: "md" }); t.text.raw = ""; t.body.append(t.text); }
  t.text.raw += text;
  dirty.add(t.text);
  if (!renderQueued) {
    renderQueued = requestAnimationFrame(() => {
      renderQueued = 0;
      for (const el of dirty) el.innerHTML = md(el.raw);
      dirty.clear();
      keepWorkingLast();
      scrollDown();
    });
  }
}
const dirty = new Set(); // text blocks waiting for their next markdown render
let renderQueued = 0;

function keepWorkingLast() {
  if (turn?.working) turn.body.append(turn.working);
}

// A step is a <details>: the row is the summary, and its full input and output fold out below.
function addStep(m) {
  if (m.parent) return addChildStep(m);
  const t = ensureTurn();
  t.text = null;
  endThinking(t);
  t.count++;
  const box = stepBox(m);
  t.body.append(box);
  working(false); // the step's own spinner shows progress
  scrollDown();
}

function stepBox(m) {
  const subject = m.file
    ? h("span", { class: "chip file-link", "data-file": m.file, title: m.detail }, icon("file"), base(m.detail) + (m.range ? ` ${m.range}` : ""))
    : m.detail ? h(m.code ? "code" : "span", { class: "detail ellipsis", title: m.detail }, m.detail) : null;
  const row = h("summary", { class: "step running", "data-id": m.id, onclick: (e) => { if (!box.classList.contains("has-body")) e.preventDefault(); else box.dataset.touched = "1"; } },
    h("span", { class: "status" }, icon("loading", "spin")), icon(m.icon || "tools", "step-icon"), h("span", { class: "title" }, m.title), subject,
    h("span", { class: "meta" }), icon("chevron-right", "chev step-chev"));
  const box = h("details", { class: "step-box" }, row, h("div", { class: "step-body" }));
  if (m.full) ioBlock(box, m.name === "Bash" ? "Command" : m.name === "Agent" || m.name === "Task" ? "Prompt" : "Input", m.full);
  return box;
}

const stepRow = (id) => id && scroll.querySelector(`.step[data-id="${CSS.escape(id)}"]`);

// A sub-agent's own steps nest under its Agent step, which stays open while they stream in (unless the user folded it).
function addChildStep(m) {
  const parent = stepRow(m.parent);
  if (!parent) return;
  const pbox = parent.parentElement;
  let subs = $(":scope > .step-body > .substeps", pbox);
  if (!subs) { subs = h("div", { class: "substeps" }); $(".step-body", pbox).prepend(subs); pbox.classList.add("has-body"); }
  subs.append(stepBox(m));
  if (!pbox.dataset.touched) pbox.open = true;
  const n = subs.children.length;
  $(".meta", parent).textContent = `${n} step${n === 1 ? "" : "s"}`;
  scrollDown();
}

// The agent is done: fold its steps away again unless the user opened or closed it.
function settleAgent(row) {
  if (!row.parentElement.dataset.touched) row.parentElement.open = false;
}

function ioBlock(box, label, text, cls = "") {
  box.classList.add("has-body");
  $(".step-body", box).append(h("div", { class: `codeblock io ${cls}` },
    h("div", { class: "codebar" }, h("span", {}, label), h("button", { class: "icon-btn copy-code", title: "Copy" }, icon("copy"))),
    h("pre", {}, h("code", {}, text))));
}

function stepResult(m) {
  const el = stepRow(m.id);
  if (!el) return;
  if (m.output) ioBlock(el.parentElement, m.isError ? "Error" : "Output", m.output, m.isError ? "io-error" : "");
  if (m.images?.length) { // e.g. Claude reading a screenshot: show it, click to open in VS Code
    const box = el.parentElement;
    box.classList.add("has-body");
    $(".step-body", box).append(h("div", { class: "step-images" }, m.images.map((img) =>
      h("img", { src: img.url, alt: "Image from this step", title: "Open image", role: "button", tabindex: "0", onclick: () => send({ type: "openImage", mediaType: img.mediaType, data: img.data }) }))));
    if (!box.dataset.touched) box.open = true;
  }
  el.classList.remove("running");
  if (!m.parent && S.busy && turn && !turn.body.querySelector(".step.running")) working(true); // between steps: Claude is deciding what's next
  if (m.background) { // launched: it keeps going after this reply, until its task notification
    el.classList.add("bg");
    $(".status", el).replaceChildren(icon("sync", "spin accent"));
    $(".meta", el).textContent = m.summary;
    return;
  }
  if ($(".substeps", el.parentElement)) settleAgent(el);
  el.classList.toggle("error", !!m.isError);
  $(".status", el).replaceChildren(icon(m.isError ? "error" : "check"));
  const meta = $(".meta", el);
  if (m.diff) meta.replaceChildren(h("span", { class: "add" }, `+${m.diff.added}`), h("span", { class: "del" }, `-${m.diff.removed}`));
  else if (m.summary) meta.textContent = m.summary;
  if (m.isError && m.error) el.title = m.error;
}

// Thinking often arrives without visible text; only show a row once there is something to read.
function addThinking() {
  const t = ensureTurn();
  endThinking(t);
  working(true, "Thinking…");
}

function addThinkingText(text) {
  const t = ensureTurn();
  if (!t.thinking) {
    if (!text.trim()) return;
    t.text = null;
    t.thinking = h("details", { class: "thinking" }, h("summary", {}, icon("lightbulb"), h("span", { class: "think-label shimmer" }, "Thinking…")), h("div", { class: "thinking-text muted" }));
    t.body.append(t.thinking);
    working(false); // the row itself says "Thinking…"
  }
  $(".thinking-text", t.thinking).textContent += text;
}

// After a turn: fold everything up to the last step into "Completed N steps", keep the answer visible.
function finalize(ms) {
  const t = turn;
  if (!t) return;
  turn = null;
  endThinking(t);
  if (t.working) t.working.remove();
  const kids = [...t.body.children];
  let lastStep = -1;
  kids.forEach((k, i) => { if (k.matches(".step-box, .thinking, .permission")) lastStep = i; });
  if (lastStep >= 0 && t.count) {
    const secs = ms ? ` in ${ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + "s" : Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s"}` : "";
    const errors = kids.slice(0, lastStep + 1).filter((k) => k.querySelector(".step.error")).length;
    const group = h("details", { class: "steps-group" },
      h("summary", {}, icon("chevron-right", "chev"), `${t.count} step${t.count === 1 ? "" : "s"}${secs}`, errors ? h("span", { class: "del" }, ` · ${errors} failed`) : null));
    group.append(...kids.slice(0, lastStep + 1));
    // images from the steps stay in sight as small thumbnails on the folded line
    const imgs = [...group.querySelectorAll(".step-images img")].slice(0, 6);
    if (imgs.length) $("summary", group).append(h("span", { class: "summary-thumbs" }, imgs.map((img) =>
      h("img", { src: img.src, alt: "", title: "Open image", onclick: (e) => { e.preventDefault(); img.click(); } }))));
    t.body.prepend(group);
  }
  for (const s of t.body.querySelectorAll(".step.running")) {
    if (s.closest(".substeps")?.closest(".step-box")?.querySelector(":scope > .step.bg")) continue; // a background agent is still working on it
    s.classList.remove("running"); $(".status", s).replaceChildren(icon("circle-slash")); }
  const answer = [...t.body.querySelectorAll(":scope > .md")].map((e) => e.raw).join("\n\n");
  if (answer || t.payload) {
    const cp = t.payload?.checkpoint;
    t.body.append(h("div", { class: "msg-actions" },
      answer && h("button", { class: "icon-btn", title: "Copy answer", onclick: () => send({ type: "copy", text: answer }) }, icon("copy")),
      t.payload && h("button", { class: "icon-btn", title: "Retry", onclick: () => { if (!S.busy) dispatch(t.payload); } }, icon("refresh")),
      cp && h("button", { class: "icon-btn restore-btn", title: "Restore checkpoint: undo this message's file changes and remove it and everything after", onclick: () => !S.busy && send({ type: "restore", checkpoint: cp }) }, icon("discard"))));
  }
}

function errorBox(text) {
  const t = ensureTurn();
  t.text = null;
  t.body.append(h("div", { class: "error-box" }, icon("error"), h("div", {}, text)));
  scrollDown();
}

// ---------- approvals ----------
const append = (el, ...kids) => el.append(...kids.filter(Boolean)); // optional buttons pass `false`
function permissionCard(m) {
  const t = ensureTurn();
  t.text = null;
  const actions = h("div", { class: "actions" });
  const decide = (allow, extra = {}, label) => {
    send({ type: "permission", id: m.id, allow, ...extra });
    actions.replaceWith(h("div", { class: "decided muted" }, icon(allow ? "check" : "close"), label || (allow ? "Allowed" : "Rejected")));
    working(S.busy);
  };
  let card;
  if (m.kind === "plan") {
    const feedback = h("textarea", { rows: 2, placeholder: "Or tell it what to change…" });
    append(actions, 
      h("button", { class: "primary", onclick: () => decide(true, {}, "Plan approved, building") }, icon("play"), "Approve & build"),
      h("button", { onclick: () => decide(false, { feedback: feedback.value.trim() }, "Kept planning") }, "Keep planning"));
    card = h("div", { class: "permission plan" }, h("div", { class: "card-title" }, icon("list-ordered"), "Proposed plan"), h("div", { class: "md", html: md(m.plan) }), feedback, actions);
  } else if (m.kind === "question") {
    const answers = {};
    const blocks = m.questions.map((q) => {
      const opts = h("div", { class: "options" }, q.options.map((o) => {
        const b = h("button", { class: "option", title: o.description || "", onclick: () => {
          if (q.multiSelect) { b.classList.toggle("selected"); answers[q.question] = [...opts.querySelectorAll(".selected")].map((x) => x.dataset.label).join(", "); }
          else { opts.querySelectorAll(".selected").forEach((x) => x.classList.remove("selected")); b.classList.add("selected"); answers[q.question] = o.label; }
        } }, h("b", {}, o.label), o.description && h("div", { class: "muted small" }, o.description));
        b.dataset.label = o.label;
        return b;
      }));
      return h("div", { class: "question" }, h("div", { class: "q" }, q.question), opts);
    });
    append(actions, h("button", { class: "primary", onclick: () => decide(true, { answers }, "Answered") }, "Submit"), h("button", { onclick: () => decide(false, {}, "Skipped") }, "Skip"));
    card = h("div", { class: "permission" }, h("div", { class: "card-title" }, icon("question"), "Bitsmith has a question"), blocks, actions);
  } else if (m.kind === "edit") {
    append(actions, 
      h("button", { class: "primary", onclick: () => decide(true, {}, "Applied") }, icon("check"), "Apply"),
      !m.risk && h("button", { title: "Apply this and every later edit in this chat without asking", onclick: () => decide(true, { allEdits: true }, "Applied · later edits in this chat apply without asking") }, icon("check-all"), "Allow all edits in this chat"),
      h("button", { onclick: () => decide(false) }, "Reject"),
      m.hasDiff && h("button", { class: "ghost", onclick: () => send({ type: "showProposed", id: m.id }) }, icon("diff"), "View diff"));
    card = h("div", { class: "permission" }, h("div", { class: "card-title" }, icon("edit"), `${m.name} `, h("span", { class: "chip file-link", "data-file": m.detail }, icon("file"), base(m.detail)), "?"),
      m.risk && h("div", { class: "risk" }, icon("warning"), m.risk), actions);
  } else {
    append(actions, 
      h("button", { class: "primary", onclick: () => decide(true) }, "Allow"),
      m.canAlways && h("button", { onclick: () => decide(true, { always: true }, "Allowed for this session") }, "Allow for session"),
      h("button", { class: "ghost", onclick: () => decide(false) }, "Reject"));
    card = h("div", { class: "permission" }, h("div", { class: "card-title" }, icon("shield"), m.question || `Allow ${m.name}?`),
      m.sub && h("div", { class: "muted small" }, m.sub), m.detail && h("pre", { class: "cmd" }, m.detail), actions);
  }
  t.body.append(card);
  working(false);
  scrollDown(true);
}

// ---------- panels above the box ----------
function renderTodos() {
  if (cur !== shown) return;
  const list = S.todos;
  todosPanel.classList.toggle("hidden", !list.length || list.every((t) => t.status === "completed") && !S.busy);
  if (!list.length) return;
  const done = list.filter((t) => t.status === "completed").length;
  const open = todosPanel.querySelector("details")?.open ?? false;
  const statusIcon = (s) => (s === "completed" ? icon("pass-filled", "ok") : s === "in_progress" ? icon("loading", "spin accent") : icon("circle-large-outline", "muted"));
  const current = list.find((t) => t.status === "in_progress");
  todosPanel.replaceChildren(h("details", { open },
    h("summary", {}, icon("chevron-right", "chev"), icon("checklist"), `Todos (${done}/${list.length})`, current && h("span", { class: "muted ellipsis" }, " · " + (current.activeForm || current.content))),
    h("div", { class: "todo-list" }, list.map((t) => h("div", { class: `todo ${t.status}` }, statusIcon(t.status), h("span", {}, t.content))))));
}

// Background tasks still running in the chat on screen: what they are, how long they've run, Stop and Output.
const TASK_ICON = { local_agent: "hubot", local_bash: "terminal" };
const elapsed = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
function renderTasks() {
  if (cur !== shown) return;
  const list = cur.tasks;
  tasksPanel.classList.toggle("hidden", !list.length);
  if (!list.length) return;
  const open = tasksPanel.querySelector("details")?.open ?? true;
  const agents = list.filter((t) => t.type === "local_agent").length;
  const label = [agents && `${agents} agent${agents === 1 ? "" : "s"}`, list.length - agents && `${list.length - agents} command${list.length - agents === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  tasksPanel.replaceChildren(h("details", { open },
    h("summary", {}, icon("chevron-right", "chev"), icon("loading", "spin accent"), `Running in background · ${label}`),
    h("div", { class: "task-list" }, list.map((t) => h("div", { class: "task-row", role: "button", tabindex: "0", title: t.progress || t.description, onclick: () => revealStep(t.toolUseId) },
      icon(TASK_ICON[t.type] || "tools", "task-icon"),
      h("div", { class: "task-text" }, h("div", { class: "ellipsis" }, t.description), t.progress && t.progress !== t.description && h("div", { class: "muted small ellipsis" }, t.progress)),
      h("span", { class: "muted small time", "data-start": t.start }, elapsed(t.start)),
      h("span", { class: "row-actions" },
        t.type === "local_bash" && h("button", { class: "icon-btn", title: "Open output", onclick: (e) => { e.stopPropagation(); send({ type: "taskOutput", taskId: t.id }); } }, icon("output")),
        h("button", { class: "icon-btn", title: "Stop task", onclick: (e) => { e.stopPropagation(); send({ type: "stopTask", taskId: t.id }); } }, icon("debug-stop"))))))));
}
setInterval(() => tasksPanel.querySelectorAll("[data-start]").forEach((e) => (e.textContent = elapsed(+e.dataset.start))), 1000);

function revealStep(id) {
  const row = stepRow(id);
  if (!row) return;
  for (let d = row.parentElement.parentElement.closest("details"); d; d = d.parentElement.closest("details")) d.open = true; // folded groups around it
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1200);
}

// A background task ended: a line in the chat, and its step settles. Between replies the line stands on its own,
// and whatever Claude says about it next comes as a reply without a user message.
const TASK_END = { completed: ["pass", "ok"], failed: ["error", "del"], stopped: ["circle-slash", "muted"], killed: ["circle-slash", "muted"] };
function taskEvent(m) {
  const [ic, cls] = TASK_END[m.status] || TASK_END.completed;
  const row = h("div", { class: `task-event ${m.status}` }, icon(ic, cls), h("span", { class: "grow ellipsis", title: m.summary }, m.summary || `Background task ${m.status}`),
    m.toolUseId && stepRow(m.toolUseId) && h("button", { class: "link-btn", onclick: () => revealStep(m.toolUseId) }, "Show step"),
    m.outputFile && h("button", { class: "link-btn", onclick: () => send({ type: "open", file: m.outputFile }) }, "Output"));
  eventRow(row);
  const step = stepRow(m.toolUseId);
  if (step) {
    step.classList.remove("bg", "running");
    step.classList.toggle("error", m.status === "failed");
    $(".status", step).replaceChildren(icon(m.status === "completed" ? "check" : m.status === "failed" ? "error" : "circle-slash"));
    $(".meta", step).textContent = m.status === "completed" ? "" : m.status;
    if (m.result) ioBlock(step.parentElement, "Result", m.result);
    settleAgent(step);
  }
  scrollDown();
}

function renderChanges() {
  const files = S.changes;
  changesPanel.classList.toggle("hidden", !files.length);
  if (!files.length) return;
  const add = files.reduce((n, f) => n + f.added, 0), del = files.reduce((n, f) => n + f.removed, 0);
  const open = changesPanel.querySelector("details")?.open ?? false;
  changesPanel.replaceChildren(h("details", { open },
    h("summary", {}, icon("chevron-right", "chev"), `${files.length} file${files.length === 1 ? "" : "s"} changed`, h("span", { class: "add" }, ` +${add}`), h("span", { class: "del" }, ` -${del}`), h("span", { class: "grow" }),
      h("button", { class: "primary small", onclick: (e) => { e.preventDefault(); send({ type: "keep" }); } }, "Keep"),
      h("button", { class: "small", onclick: (e) => { e.preventDefault(); send({ type: "undo" }); } }, "Undo")),
    h("div", { class: "file-list" }, files.map((f) => h("div", { class: "file-row file-link", role: "button", tabindex: "0", "data-file": f.file, title: f.rel },
      icon(f.created ? "new-file" : f.deleted ? "trash" : "file", "file-icon"),
      h("span", { class: "file-name" }, base(f.rel)),
      h("span", { class: "file-dir" }, dir(f.rel)),
      h("span", { class: "file-stats" }, h("span", { class: "add" }, `+${f.added}`), h("span", { class: "del" }, `-${f.removed}`)),
      h("span", { class: "row-actions" },
        h("button", { class: "icon-btn", title: "View diff", onclick: (e) => { e.stopPropagation(); send({ type: "diffFile", file: f.file }); } }, icon("diff")),
        h("button", { class: "icon-btn", title: "Keep", onclick: (e) => { e.stopPropagation(); send({ type: "keep", file: f.file }); } }, icon("check")),
        h("button", { class: "icon-btn", title: "Undo", onclick: (e) => { e.stopPropagation(); send({ type: "undo", file: f.file }); } }, icon("discard"))))))));
}

// ---------- sending ----------
function setBusy(on) {
  S.busy = on;
  cur.busy = on;
  renderTabs();
  if (cur !== shown) return;
  document.body.classList.toggle("busy", on);
  stopBtn.classList.toggle("hidden", !on);
  sendBtn.title = on ? "Queue: sent when this reply ends (Enter)" : "Send (Enter)";
  input.placeholder = on ? "Queue a follow-up… it's sent when this reply ends" : "Ask Bitsmith to build, fix or explain…";
  if (!on) renderTodos();
  if (cur.queue.length) renderQueue(); // "Send now" only while idle
}

function submit() {
  const text = input.value.trim();
  if (!text && !S.images.length) return;
  const a = S.useActive && !activeIsAttached() && S.active;
  const chipsShown = [...(a ? [{ kind: "file", rel: a.rel, file: a.file, range: a.selection ? `${a.selection.start}-${a.selection.end}` : "" }] : []), ...S.items];
  const payload = { text: text || "See the attached image.", images: S.images, items: S.items, useActive: !!a, chips: chipsShown };
  if (S.busy) { cur.queue.push(payload); renderQueue(); } // sent when this reply ends, like typing ahead in the terminal
  else dispatch(payload);
  input.value = "";
  S.items = [];
  S.images = [];
  autosize();
  renderChips();
  drawThumbs();
  mention = null;
  renderSlash();
}

function renderQueue() {
  if (synced) send({ type: "queue", items: cur.queue.map(({ text, items, chips, useActive }) => ({ text, items, chips, useActive })) }); // kept by the extension across reloads
  if (cur !== shown) return;
  const q = cur.queue;
  queuePanel.classList.toggle("hidden", !q.length);
  queuePanel.replaceChildren(...q.map((p, i) => h("div", { class: "queued" }, icon("clock", "muted"),
    h("span", { class: "ellipsis grow", title: p.text }, p.text), h("span", { class: "muted small" }, i ? `queued #${i + 1}` : "next"),
    !S.busy && !i && h("button", { class: "icon-btn", title: "Send now", onclick: () => { if (S.busy) return; dispatch({ images: [], ...q.shift() }); renderQueue(); } }, icon("play")),
    h("button", { class: "icon-btn", title: "Edit: move it back to the input", onclick: () => { q.splice(i, 1); unqueue([p]); } }, icon("edit")),
    h("button", { class: "icon-btn", title: "Remove from queue", onclick: () => { q.splice(i, 1); renderQueue(); } }, icon("close")))));
}

// Queued messages go back into the input (text, files and images), ahead of anything typed since.
function unqueue(list) {
  input.value = [...list.map((p) => (p.text === "See the attached image." ? "" : p.text)), input.value].filter(Boolean).join("\n\n");
  for (const p of list) { S.items.push(...p.items); S.images.push(...p.images); }
  renderQueue();
  renderChips();
  autosize();
  input.focus();
}

// Stopping means "not like this": the queued messages shouldn't fire on their own.
function stop() {
  if (cur.queue.length) unqueue(cur.queue.splice(0));
  send({ type: "stop" });
}

// ---------- context meter: how full the conversation is; a click runs /compact ----------
const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
function renderMeter() {
  if (cur !== shown) return;
  const c = cur.context;
  meterBtn.classList.toggle("hidden", !c?.used);
  if (!c?.used) return;
  const pct = Math.min(100, Math.round((c.used / c.window) * 100));
  meterBtn.className = `context-meter ${pct >= 90 ? "crit" : pct >= 70 ? "warn" : ""}`;
  meterBtn.style.setProperty("--pct", pct);
  meterBtn.title = `Context: ${kTok(c.used)} of ${kTok(c.window)} tokens (${pct}%)\nClick to compact: Claude summarizes the conversation so far to free up space.`;
  meterBtn.setAttribute("aria-label", `Context ${pct}% full. Compact conversation`);
  meterBtn.replaceChildren(h("span", { class: "ring" }), `${pct}%`);
}
function compact() {
  if (!S.busy) dispatch({ text: "/compact", images: [], items: [], useActive: false, chips: [] });
}

// A line between replies (task finished, conversation compacted); inside the reply while one is running.
function eventRow(el) {
  if (!S.busy) finalize();
  (turn ? turn.body : scroll).append(el);
  scrollDown();
}

function dropRedo() {
  redo?.bar.remove();
  redo = null;
}

function renderRedo() {
  const n = redo.stack[redo.stack.length - 1].length, more = redo.stack.length - 1;
  redo.bar.replaceChildren(icon("discard"), h("span", { class: "grow" }, `Restored checkpoint · removed ${n} message${n === 1 ? "" : "s"}${more ? ` · ${more} earlier restore${more === 1 ? "" : "s"} to redo` : ""}`),
    h("button", { class: "small", title: "Bring back the messages and file changes of the latest restore", onclick: () => !S.busy && send({ type: "redo" }) }, icon("redo"), "Redo"));
  scroll.append(redo.bar);
}

function dispatch(p) {
  dropRedo();
  p = { ...p, checkpoint: nextCheckpoint++ };
  startTurn({ text: p.text, chips: p.chips, images: p.images }, p);
  setBusy(true);
  working(true);
  send({ type: "send", text: p.text, images: p.images.map(({ mediaType, data }) => ({ mediaType, data })), context: p.items, useActive: p.useActive, checkpoint: p.checkpoint });
}

// Rows that act like buttons (recent chats, tabs, tasks, files, images) work from the keyboard too.
document.addEventListener("keydown", (e) => {
  const el = e.target.closest?.('[role="button"], [role="tab"]');
  if (el && el === e.target && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); el.click(); } // not for a button inside the row
});

// ---------- clicks on file chips anywhere ----------
document.addEventListener("click", (e) => {
  const link = e.target.closest(".file-link");
  if (link) e.preventDefault(); // don't also fold a step open
  if (link) return send({ type: "open", file: link.dataset.file, line: Number(link.dataset.line) || undefined });
  const copy = e.target.closest(".copy-code");
  if (copy) {
    send({ type: "copy", text: copy.closest(".codeblock").querySelector("code").textContent });
    copy.replaceChildren(icon("check"));
    setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
  }
});

// ---------- plan usage card (opened from the status bar) ----------
const usageCard = h("div", { class: "usage-card hidden", role: "dialog", "aria-label": "Plan usage" });
document.body.append(usageCard);
document.addEventListener("mousedown", (e) => { if (!usageCard.classList.contains("hidden") && !usageCard.contains(e.target)) usageCard.classList.add("hidden"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") usageCard.classList.add("hidden"); });

function untilText(t) {
  const s = t - Date.now() / 1000;
  if (!(s > 0)) return "";
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `in ${d}d ${hr}h` : hr ? `in ${hr}h ${m}m` : `in ${m}m`;
}
function resetText(t) {
  if (!t) return "";
  const date = new Date(t * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Resets ${sameDay ? time : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " at " + time}`;
}

function meter(title, sub, w) {
  const pct = w?.used == null ? null : Math.round(w.used * 100);
  const level = pct == null ? "" : pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
  return h("div", { class: "usage-row" },
    h("div", { class: "usage-line" }, h("b", {}, title), h("span", { class: "muted small" }, sub), h("span", { class: "grow" }), h("span", { class: "muted small", title: w?.resetsAt ? untilText(w.resetsAt) : "" }, resetText(w?.resetsAt))),
    h("div", { class: "usage-num" }, h("span", { class: "big" }, pct == null ? "–" : `${pct}%`), h("span", { class: "muted" }, " used")),
    h("div", { class: `bar ${level}`, role: "progressbar", "aria-valuenow": pct ?? 0, "aria-valuemin": 0, "aria-valuemax": 100 }, h("span", { style: `width:${Math.min(100, pct ?? 0)}%` })));
}

function renderUsage() {
  const u = S.usage;
  const rows = [];
  if (!u || (!u.session && !u.weekly)) {
    rows.push(h("div", { class: "usage-empty muted" }, icon("pulse"), "No usage data yet. Send a message and your limits appear here."));
  } else {
    if (u.status === "rejected") rows.push(h("div", { class: "usage-alert" }, icon("warning"), `Limit reached. ${resetText(u.resetsAt)}${u.resetsAt ? " (" + untilText(u.resetsAt) + ")" : ""}.`));
    if (u.session) rows.push(meter("Session", "5-hour window", u.session));
    if (u.weekly) rows.push(meter("Weekly", "all models", u.weekly));
    rows.push(h("div", { class: "usage-kv" }, h("span", {}, "Extra usage"), h("span", { class: "grow" }),
      h("span", { class: "muted" }, u.usingOverage ? "In use" : u.overage === "rejected" ? "Off" : u.overage ? "Available" : "–")));
  }
  usageCard.replaceChildren(
    h("div", { class: "usage-head" }, logo("head-logo"), h("b", {}, "Bitsmith"), S.plan && h("span", { class: "plan" }, S.plan), h("span", { class: "grow" }),
      h("button", { class: "primary small", onclick: () => send({ type: "openUsagePage" }) }, "Manage"),
      h("button", { class: "icon-btn", title: "Close", onclick: () => usageCard.classList.add("hidden") }, icon("close"))),
    ...rows,
    h("div", { class: "usage-foot muted small" }, icon("info"), u?.updated ? `Updated ${ago(u.updated)} · refreshes with each message` : "Refreshes with each message"));
}

// ---------- chats: one pane each, switched with the tab strip ----------
function makeChat(key) {
  const el = h("div", { class: "scroll hidden", role: "log", "aria-label": "Conversation" });
  el.addEventListener("scroll", flashThumb, { passive: true });
  composer.before(el);
  const c = { key, el, turn: null, redo: null, busy: false, todos: [], tasks: [], queue: [], context: null, title: "", unread: false, attention: false };
  chats.set(key, c);
  paneResize.observe(el);
  renderTabs();
  return c;
}

// Point the conversation functions (turn, redo, busy, todos, scroll) at chat `c`.
function enter(c) {
  if (c === cur) return;
  if (cur) Object.assign(cur, { turn, redo, busy: S.busy, todos: S.todos });
  cur = c;
  ({ turn, redo } = c);
  S.busy = c.busy;
  S.todos = c.todos;
  scroll = c.el;
}

function inChat(key, fn) {
  const prev = cur;
  enter(chats.get(key) || makeChat(key));
  try { fn(); } finally { enter(prev); }
}

function showChat(key, tell) {
  const c = chats.get(key) || makeChat(key);
  enter(c);
  shown = c;
  const caughtUp = c.busy || c.unread; // it kept going while hidden: show the latest
  c.unread = c.attention = false;
  for (const x of chats.values()) x.el.classList.toggle("hidden", x !== c);
  const started = !!scroll.querySelector(".turn");
  if (!started) scroll.prepend(empty); // the hero lives in whichever pane is on screen
  showEmpty(!started);
  setBusy(c.busy);
  renderTodos();
  renderTasks();
  renderQueue();
  renderMeter();
  if (caughtUp) scrollDown(true);
  placeThumb();
  if (tell) send({ type: "switchChat" });
}

function closeChat(key) {
  const c = chats.get(key);
  if (!c) return;
  chats.delete(key);
  c.el.remove();
  if (c === shown) { cur = shown = null; const next = [...chats.values()].pop(); if (next) showChat(next.key); }
  renderTabs();
}

function renderTabs() {
  tabsBar.classList.toggle("hidden", chats.size < 2);
  if (chats.size < 2) return;
  tabsBar.replaceChildren(...[...chats.values()].map((c) => {
    const state = c.attention ? icon("bell-dot", "attn") : c.busy || c.tasks.length ? icon("loading", "spin")
      : c.unread ? h("span", { class: "dot", title: "New reply" }) : icon("comment-discussion", "muted");
    return h("div", { class: `chat-tab ${c === shown ? "active" : ""}`, role: "tab", tabindex: "0", "aria-selected": String(c === shown), title: (c.title || "New chat") + " · double-click to rename",
      onclick: () => c !== shown && showChat(c.key, true), ondblclick: () => send({ type: "renameChat", chat: c.key }) },
      state, h("span", { class: "ellipsis" }, c.title || "New chat"),
      h("button", { class: "icon-btn close", title: "Close chat", "aria-label": `Close chat: ${c.title || "New chat"}`, onclick: (e) => { e.stopPropagation(); send({ type: "closeChat", chat: c.key }); } }, icon("close")));
  }));
}

// ---------- messages from the extension ----------
const PANEL_MESSAGES = new Set(["openChat", "showChat", "closeChat", "chatTitle"]); // about chats, not inside one
function onMessage(m) {
  if (m.chat && !PANEL_MESSAGES.has(m.type)) return inChat(m.chat, () => handle(m));
  handle(m);
}

function handle(m) {
  switch (m.type) {
    case "chats":
      synced = true;
      for (const c of m.chats) (chats.get(c.key) || makeChat(c.key)).title = c.title;
      return showChat(m.active);
    case "openChat": if (!chats.has(m.chat)) makeChat(m.chat); return;
    case "showChat": return showChat(m.chat);
    case "closeChat": return closeChat(m.chat);
    case "chatTitle": { const c = chats.get(m.chat); if (c) { c.title = m.title; renderTabs(); } return; }
    case "tasks": cur.tasks = m.tasks; renderTasks(); return renderTabs();
    case "taskEvent": return taskEvent(m);
    case "autoTurn": if (!turn) startTurn(null); setBusy(true); working(true); return;
    case "queue": cur.queue = (m.items || []).map((p) => ({ images: [], items: [], chips: [], ...p })); return renderQueue();
    case "context": cur.context = { used: m.used, window: m.window }; return renderMeter();
    case "notice": return eventRow(h("div", { class: "task-event notice" }, icon(m.icon || "info"), h("span", { class: "grow" }, m.text)));
    case "status": if (turn) working(true, m.text); return;
    case "fileResults": if (mention && m.q === mention.q) { mention.items = m.items; mention.index = 0; renderSlash(); } return;
    case "agentProgress": { const row = stepRow(m.toolUseId); if (row && m.text) row.title = m.text; return; }
    case "settings": Object.assign(S, { model: m.model, effort: m.effort, mode: m.mode, policy: m.policy }); return renderToolbar();
    case "init": S.models = m.models; S.commands = m.commands; return renderToolbar();
    case "usage": S.usage = m.usage; S.plan = m.plan; return renderUsage();
    case "showUsage": renderUsage(); usageCard.classList.toggle("hidden"); return;
    case "activeFile": S.active = m.file; return renderChips();
    case "addContext": return addItems(m.items);
    case "sessions": S.sessions = m.items; return renderEmpty();
    case "text": return addText(m.text);
    case "textStart": if (turn) turn.text = null; return; // a new text block is a new paragraph, not a continuation
    case "thinkingStart": return addThinking();
    case "thinking": return addThinkingText(m.text);
    case "tool": return addStep(m);
    case "toolResult": return stepResult(m);
    case "todos": S.todos = m.todos; return renderTodos();
    case "changes": S.changes = m.files; return renderChanges();
    case "permission":
      permissionCard(m);
      if (cur !== shown) { cur.attention = true; renderTabs(); } // waiting on the user in a background chat
      return;
    case "error": return errorBox(m.text);
    case "done":
      finalize(m.ms);
      setBusy(false);
      if (cur.queue.length) { dispatch(cur.queue.shift()); return renderQueue(); } // next queued message
      if (cur === shown) input.focus();
      else { cur.unread = true; renderTabs(); }
      return;
    case "user": return startTurn({ text: m.text, chips: m.chips || [], images: m.images || [] }, m.checkpoint ? { checkpoint: m.checkpoint, text: m.text, chips: m.chips || [], items: [], images: m.images || [], useActive: false } : null);
    case "editCancelled": {
      const b = scroll.querySelector(`.turn[data-checkpoint="${m.checkpoint}"] .user-msg`);
      b?.classList.remove("pending");
      b?.cancelEdit?.();
      return;
    }
    case "approvalsCancelled":
      for (const a of scroll.querySelectorAll(".permission .actions")) a.replaceWith(h("div", { class: "decided muted" }, "Cancelled"));
      return;
    case "redone":
      if (!redo) return;
      scroll.append(...redo.stack.pop());
      if (redo.stack.length) renderRedo(); // another restore can still be redone
      else dropRedo();
      if (cur === shown) { input.value = ""; S.items = []; renderChips(); autosize(); } // the composer belongs to the chat on screen
      showEmpty(false);
      return scrollDown(true);
    case "restored": {
      finalize();
      const at = scroll.querySelector(`.turn[data-checkpoint="${m.checkpoint}"]`);
      if (!at) return;
      const payload = at.payload;
      const nodes = [];
      for (let el = at; el; ) { const next = el.nextElementSibling; el.remove(); nodes.push(el); el = next; }
      redo?.bar.remove(); // removed with the messages if it sat among them; it goes back at the end
      redo ||= { stack: [], bar: h("div", { class: "redo-bar" }) };
      redo.stack.push(nodes.filter((n) => n !== redo.bar));
      renderRedo();
      if (m.resend != null && payload) {
        dropRedo(); // an edit starts a new branch, nothing to redo
        S.todos = [];
        renderTodos();
        showEmpty(false);
        dispatch({ ...payload, text: m.resend, chips: payload.chips || [] });
        return;
      }
      if (payload && cur === shown) {
        input.value = payload.text === "See the attached image." ? "" : payload.text;
        S.items = payload.items || [];
        renderChips();
        autosize();
        input.focus();
      }
      S.todos = [];
      renderTodos();
      showEmpty(!scroll.querySelector(".turn"));
      return;
    }
    case "replay":
      for (const item of m.items) handle(item);
      finalize();
      return scrollDown(true);
    case "clear":
      redo = null;
      turn = null;
      scroll.replaceChildren(...(cur === shown ? [empty] : []));
      showEmpty(true);
      S.todos = [];
      renderTodos();
      cur.queue = [];
      renderQueue();
      setBusy(false);
      return;
  }
}
window.addEventListener("message", (e) => onMessage(e.data));

// ---------- overlay scrollbar for the chat: appears while scrolling, fades out, draggable ----------
const thumb = h("div", { class: "overlay-thumb", "aria-hidden": "true" });
document.body.append(thumb);
let fadeTimer;
function placeThumb() {
  const r = scroll.getBoundingClientRect();
  const max = scroll.scrollHeight - scroll.clientHeight;
  if (max <= 1) { thumb.style.display = "none"; return; }
  const height = Math.max(28, r.height * (scroll.clientHeight / scroll.scrollHeight));
  thumb.style.display = "";
  thumb.style.height = height + "px";
  thumb.style.top = r.top + (r.height - height) * (scroll.scrollTop / max) + "px";
  thumb.style.left = r.right - 9 + "px";
}
function flashThumb() {
  placeThumb();
  thumb.classList.add("show");
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => thumb.classList.remove("show"), 900);
}
window.addEventListener("resize", placeThumb);
const paneResize = new ResizeObserver(placeThumb); // chat panes observe it as they're made
thumb.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const startY = e.clientY, startTop = scroll.scrollTop;
  const ratio = scroll.scrollHeight / scroll.clientHeight;
  thumb.classList.add("dragging");
  const move = (ev) => { scroll.scrollTop = startTop + (ev.clientY - startY) * ratio; };
  const up = () => { thumb.classList.remove("dragging"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); flashThumb(); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// ---------- boot ----------
showChat(document.body.dataset.chat || "c1"); // the chat this view opens on; "chats" on ready brings any others
renderEmpty();
renderToolbar();
renderChips();
send({ type: "ready" });
input.focus();
