const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const win = window.__TAURI__.window.getCurrentWindow();

const $ = (id) => document.getElementById(id);
const state = { mods: [], releases: {}, selected: null, busy: {}, kronos: null, tab: "notes" };

// ---------- helpers ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/g, '<a data-url="$2">$1</a>');
}

// small markdown subset used in release notes and READMEs: headings, bullets, tables, paragraphs, bold, code, GitHub links
function markdown(md) {
  let html = "", list = false, table = false;
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const bullet = line.match(/^[-*]\s+(.*)/);
    const row = line.startsWith("|");
    if (!bullet && list) { html += "</ul>"; list = false; }
    if (!row && table) { html += "</table>"; table = false; }
    if (!line) continue;
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (row) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // header separator
      const cells = line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((c) => inline(c.trim()));
      const tag = table ? "td" : "th";
      if (!table) { html += "<table>"; table = true; }
      html += `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    }
    else if (h) html += `<h3>${inline(h[1])}</h3>`;
    else if (bullet) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(bullet[1])}</li>`; }
    else html += `<p>${inline(line)}</p>`;
  }
  return html + (list ? "</ul>" : "") + (table ? "</table>" : "");
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

// installed mods that can't live next to m
const conflictsOf = (m) => state.mods.filter((o) => m.conflicts.includes(o.id) && o.installed);

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

  const clash = m.installed ? conflictsOf(m) : [];
  const warning = clash.length
    ? `<div class="warning"><span class="dot warn"></span><span><b>${esc(m.name)}</b> and <b>${clash.map((o) => esc(o.name)).join(", ")}</b> are both installed but can't run together. Uninstall one of them.</span></div>`
    : "";

  const features = state.tab === "features";
  let notes;
  if (!r) notes = `<div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:55%"></div>`;
  else if (r.error) notes = `<p class="notes">Couldn't load the latest release: ${esc(r.error)} <a class="link" data-act="retry">Retry</a></p>`;
  else if (features) notes = `<div class="notes">${markdown(r.features) || "<p>No feature list yet.</p>"}</div>`;
  else notes = `<div class="notes">${markdown(r.notes) || "<p>No release notes.</p>"}</div>`;
  const link = r && !r.error
    ? `<a class="link" data-url="${esc(features ? `https://github.com/${m.repo}#readme` : r.url)}">View on GitHub</a>`
    : "";

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
      ${warning}
      ${progress}
      <div class="stats">
        <div class="stat"><div class="k">Released</div><div class="v">${r && !r.error ? date(r.published) : "—"}</div></div>
        <div class="stat"><div class="k">Download</div><div class="v">${r && !r.error ? `${kb(r.size)} · ${r.files} files` : "—"}</div></div>
        <div class="stat"><div class="k">Source</div><div class="v"><a class="link" data-url="https://github.com/${esc(m.repo)}">${esc(m.repo)}</a></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="tabs">
            <button class="tab ${features ? "" : "active"}" data-act="tab-notes">What's new${r && !r.error ? ` in v${esc(r.version)}` : ""}</button>
            <button class="tab ${features ? "active" : ""}" data-act="tab-features">All features</button>
          </div>${link}
        </div>
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
  const clash = conflictsOf(m);
  if (clash.length) {
    const names = clash.map((o) => o.name).join(", ");
    const ok = await confirmDialog(`Install ${m.name}?`, `${m.name} and ${names} can't be installed at the same time (FuzMenu already includes the speedrun timer). ${names} will be uninstalled. Your settings and saved data are kept.`, `Remove ${names}`);
    if (!ok) return;
  }
  state.busy[id] = { label: updating ? "Updating…" : "Installing…", done: 0, total: 0 };
  render();
  try {
    const v = await invoke("install", { id });
    toast(`${m.name} v${v} ${updating ? "updated" : "installed"}. Start a Zombies match to use it.`);
    clash.forEach((o) => toast(`${o.name} uninstalled.`));
  } catch (e) {
    toast(e, "bad");
  }
  delete state.busy[id];
  await refreshMods();
  await Promise.all([id, ...clash.map((o) => o.id)].map(loadRelease));
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
    "tab-notes": () => { state.tab = "notes"; renderDetail(); },
    "tab-features": () => { state.tab = "features"; renderDetail(); },
    retry: () => { delete state.releases[id]; render(); loadRelease(id); },
  })[act.dataset.act]?.();
});

$("win-min").onclick = () => win.minimize();
$("win-close").onclick = () => win.close();
$("win-max").onclick = () => win.toggleMaximize();
// swap the maximize icon for the restore icon while maximized
const syncMax = async () => {
  const max = await win.isMaximized();
  $("win-max").innerHTML = max
    ? '<svg viewBox="0 0 10 10"><rect x="1.5" y="3" width="5.5" height="5.5"/><path d="M3 3V1.5h5.5V7H7"/></svg>'
    : '<svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg>';
  $("win-max").title = max ? "Restore" : "Maximize";
};
win.onResized(syncMax);
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

// ---------- self update ----------
async function checkSelfUpdate() {
  const u = await invoke("check_self_update").catch(() => null);
  if (!u) return;
  const b = $("self-update");
  b.innerHTML = `FuzMods v${esc(u.version)} available · Update`;
  b.classList.remove("hidden");
  b.onclick = async () => {
    b.disabled = true;
    b.innerHTML = `<span class="spin"></span>Updating…`;
    try { await invoke("self_update"); } // the app restarts on success
    catch (e) {
      toast(e, "bad");
      b.disabled = false;
      b.innerHTML = `FuzMods v${esc(u.version)} available · Update`;
    }
  };
}

// ---------- start ----------
(async () => {
  state.mods = await invoke("list_mods");
  state.selected = state.mods[0]?.id;
  render();
  checkSelfUpdate();
  const k = await invoke("get_kronos");
  setKronos(k);
  if (k) await loadAll();
  else {
    $("setup-hint").textContent = "Kronos wasn't found automatically.";
    state.mods.forEach((m) => loadRelease(m.id));
  }
})();
