const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const win = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);
const state = { mods: [], releases: {}, selected: null, busy: {}, kronos: null };

// ---------- helpers ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/g, '<a data-url="$2">$1</a>');
}

// small markdown subset used in release notes: headings, bullets, paragraphs, bold, code, GitHub links
function markdown(md) {
  let html = "", list = false;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (!bullet && list) { html += "</ul>"; list = false; }
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) html += `<h3>${inline(h[1])}</h3>`;
    else if (bullet) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(bullet[1])}</li>`; }
    else html += `<p>${inline(line)}</p>`;
  }
  return html + (list ? "</ul>" : "");
}

const kb = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");

function toast(text, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="dot"></span><span>${esc(String(text))}</span>`;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "bad" ? 7000 : 3500);
}

function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    $("dialog-title").textContent = title;
    $("dialog-text").textContent = text;
    $("dialog-ok").textContent = okLabel;
    $("dialog").classList.remove("hidden");
    const done = (v) => { $("dialog").classList.add("hidden"); $("dialog-ok").onclick = $("dialog-cancel").onclick = null; resolve(v); };
    $("dialog-ok").onclick = () => done(true);
    $("dialog-cancel").onclick = () => done(false);
  });
}

// status of a mod: "missing" | "update" | "ok" | "unknown"
function status(m) {
  if (!m.installed) return "missing";
  const r = state.releases[m.id];
  if (!r || r.error) return "unknown";
  return r.changed ? "update" : "ok";
}

// ---------- rendering ----------
function renderList() {
  $("mod-list").innerHTML = state.mods.map((m) => {
    const r = state.releases[m.id];
    const s = status(m);
    const text = { missing: "Not installed", update: "Update available", ok: `Installed · v${esc(m.installed || "")}`, unknown: `Installed · v${esc(m.installed || "")}` }[s];
    const dot = s === "ok" ? "ok" : s === "update" ? "warn" : "";
    const icon = r && r.image ? `<img src="${esc(r.image)}" alt="">` : esc(m.name[0]);
    return `<button class="mod-item ${m.id === state.selected ? "active" : ""}" data-id="${m.id}">
      <span class="mod-icon">${icon}</span>
      <span class="mod-meta"><div class="mod-name">${esc(m.name)}</div><div class="mod-status"><span class="dot ${dot}"></span>${text}</div></span>
    </button>`;
  }).join("");
}

function renderDetail() {
  const m = state.mods.find((x) => x.id === state.selected);
  if (!m) return;
  const r = state.releases[m.id];
  const busy = state.busy[m.id];
  const s = status(m);
  const anyBusy = Object.keys(state.busy).length > 0;

  let main;
  if (busy) main = `<button class="btn btn-primary" disabled><span class="spin"></span>${busy.label}</button>`;
  else if (s === "missing") main = `<button class="btn btn-primary" data-act="install" ${!r || r.error || anyBusy ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6zM5 18h14v2H5z"/></svg>Install</button>`;
  else if (s === "update") main = `<button class="btn btn-primary" data-act="install" ${anyBusy ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.9 6.7l-2 .3A6 6 0 0 0 6.3 9H9v2H3V5h2v2.3A8 8 0 0 1 12 4zm-7.9 9.3 2-.3A6 6 0 0 0 17.7 15H15v-2h6v6h-2v-2.3A8 8 0 0 1 4.1 13.3z"/></svg>Update to v${esc(r.version)}</button>`;
  else main = `<button class="btn btn-ghost" data-act="install" ${!r || r.error || anyBusy ? "disabled" : ""} title="Download every file again">Reinstall</button>`;

  const secondary = m.installed
    ? `<button class="btn btn-ghost" data-act="folder">Open folder</button>
       <button class="btn btn-danger" data-act="uninstall" ${anyBusy ? "disabled" : ""}>Uninstall</button>`
    : "";

  const chips = [
    m.installed ? `<span class="chip ${s === "ok" ? "ok" : ""}">Installed <b>v${esc(m.installed)}</b></span>` : "",
    r && !r.error ? `<span class="chip ${s === "update" ? "warn" : ""}">Latest <b>v${esc(r.version)}</b></span>` : "",
  ].join("");

  const progress = busy && busy.total
    ? `<div><div class="progress"><div style="width:${Math.round((busy.done / busy.total) * 100)}%"></div></div>
       <div class="progress-text">Downloading files · ${busy.done} / ${busy.total}</div></div>`
    : "";

  let notes;
  if (!r) notes = `<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:55%"></div>`;
  else if (r.error) notes = `<p class="notes">Couldn't load the latest release: ${esc(r.error)} <a class="link" data-act="retry">Retry</a></p>`;
  else notes = `<div class="notes">${markdown(r.notes) || "<p>No release notes.</p>"}</div>`;

  const fade = state.shown !== m.id ? "fade-in" : "";
  state.shown = m.id;
  const bg = r && r.image ? `style="background-image:url('${esc(r.image)}')"` : "";
  $("detail").innerHTML = `
    <section class="hero ${fade}">
      <div class="hero-bg ${bg ? "" : "none"}" ${bg}></div>
      ${r && r.image ? `<img class="hero-art" src="${esc(r.image)}" alt="">` : ""}
      <div class="hero-content">
        <h1>${esc(m.name)}</h1>
        <p class="tagline">${esc(m.tagline)}</p>
      </div>
    </section>
    <section class="body ${fade}">
      <div class="actions">${main}${secondary}<div class="chips">${chips}</div></div>
      ${progress}
      <div class="stats">
        <div class="stat"><div class="k">Released</div><div class="v">${r && !r.error ? date(r.published) : "—"}</div></div>
        <div class="stat"><div class="k">Download</div><div class="v">${r && !r.error ? `${kb(r.size)} · ${r.files} files` : "—"}</div></div>
        <div class="stat"><div class="k">Source</div><div class="v"><a class="link" data-url="https://github.com/${esc(m.repo)}">${esc(m.repo)}</a></div></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>What's new${r && !r.error ? ` in v${esc(r.version)}` : ""}</h2>${r && !r.error ? `<a class="link" data-url="${esc(r.url)}">View on GitHub</a>` : ""}</div>
        ${notes}
      </div>
    </section>`;
}

function render() { renderList(); renderDetail(); }

// ---------- data ----------
async function refreshMods() {
  state.mods = await invoke("list_mods");
  render();
}

async function loadRelease(id) {
  try { state.releases[id] = await invoke("fetch_release", { id }); }
  catch (e) { state.releases[id] = { error: String(e) }; }
  render();
}

async function loadAll() {
  await refreshMods();
  await Promise.all(state.mods.map((m) => loadRelease(m.id)));
}

function setKronos(path) {
  state.kronos = path;
  $("folder-path").textContent = path || "Not set";
  $("setup").classList.toggle("hidden", !!path);
}

// ---------- actions ----------
async function install(id) {
  const m = state.mods.find((x) => x.id === id);
  const updating = !!m.installed;
  state.busy[id] = { label: updating ? "Updating…" : "Installing…", done: 0, total: 0 };
  render();
  try {
    const v = await invoke("install", { id });
    toast(`${m.name} v${v} ${updating ? "updated" : "installed"}. Start a Zombies match to use it.`);
  } catch (e) {
    toast(e, "bad");
  }
  delete state.busy[id];
  await refreshMods();
  await loadRelease(id);
}

async function uninstall(id) {
  const m = state.mods.find((x) => x.id === id);
  const ok = await confirmDialog(`Uninstall ${m.name}?`, "The mod files are removed from Kronos. Your settings and saved data are kept, so a reinstall brings everything back.", "Uninstall");
  if (!ok) return;
  try {
    await invoke("uninstall", { id });
    toast(`${m.name} uninstalled.`);
  } catch (e) { toast(e, "bad"); }
  await refreshMods();
  await loadRelease(id);
}

async function pickFolder() {
  try {
    const p = await invoke("pick_kronos");
    if (p) { setKronos(p); $("setup-hint").textContent = ""; await loadAll(); }
  } catch (e) {
    $("setup-hint").textContent = String(e);
    toast(e, "bad");
  }
}

// ---------- events ----------
document.addEventListener("click", (ev) => {
  const link = ev.target.closest("[data-url]");
  if (link) { invoke("open_url", { url: link.dataset.url }).catch((e) => toast(e, "bad")); return; }
  const item = ev.target.closest(".mod-item");
  if (item) { state.selected = item.dataset.id; render(); return; }
  const act = ev.target.closest("[data-act]");
  if (!act) return;
  const id = state.selected;
  ({
    install: () => install(id),
    uninstall: () => uninstall(id),
    folder: () => invoke("open_folder", { id }).catch((e) => toast(e, "bad")),
    retry: () => { delete state.releases[id]; render(); loadRelease(id); },
  })[act.dataset.act]?.();
});

$("win-min").onclick = () => win.minimize();
$("win-close").onclick = () => win.close();
$("change-folder").onclick = pickFolder;
$("setup-browse").onclick = pickFolder;
$("open-kronos").onclick = () => invoke("open_folder", { id: null }).catch((e) => toast(e, "bad"));
$("play").onclick = () => invoke("launch_kronos").then(() => toast("Starting Kronos…")).catch((e) => toast(e, "bad"));
document.addEventListener("contextmenu", (e) => e.preventDefault());

listen("progress", ({ payload }) => {
  const b = state.busy[payload.id];
  if (!b) return;
  b.done = payload.done; b.total = payload.total;
  renderDetail();
});

// ---------- start ----------
(async () => {
  state.mods = await invoke("list_mods");
  state.selected = state.mods[0]?.id;
  render();
  const k = await invoke("get_kronos");
  setKronos(k);
  if (k) await loadAll();
  else {
    $("setup-hint").textContent = "Kronos wasn't found automatically.";
    state.mods.forEach((m) => loadRelease(m.id));
  }
})();
