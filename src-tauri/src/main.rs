#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

struct ModDef {
    id: &'static str,
    name: &'static str,
    repo: &'static str,
    tagline: &'static str,
    image: &'static str, // release asset used as the card picture
    conflicts: &'static [&'static str], // mods that must not be installed at the same time
}

const MODS: &[ModDef] = &[
    ModDef {
        id: "fuzmenu",
        name: "FuzMenu",
        repo: "Fuzion28/fuzmenu",
        tagline: "The all-in-one BO7 Zombies mod menu: god mode, weapons, Pack-a-Punch, perks, gobblegums, rounds, zombie spawns, game modes, Forge, boss fights and more.",
        image: "fuzmenu_logo.png",
        conflicts: &["fuzspeedrun"], // FuzMenu already includes the speedrun timer, same Lua files
    },
    ModDef {
        id: "fuzspeedrun",
        name: "FuzSpeedrun",
        repo: "Fuzion28/fuzspeedrun",
        tagline: "Speedrun timer for BO7 Zombies: live timer, automatic splits for every map, personal bests and a LiveSplit autosplitter.",
        image: "preview.png",
        conflicts: &["fuzmenu"],
    },
];

#[derive(Default, Serialize, Deserialize)]
struct Config {
    kronos: Option<PathBuf>,
}

struct AppState {
    config: Mutex<Config>,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct ModInfo {
    id: String,
    name: String,
    repo: String,
    tagline: String,
    installed: Option<String>,
    conflicts: Vec<String>,
}

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    published_at: Option<String>,
    html_url: String,
    assets: Vec<GhAsset>,
}

#[derive(Serialize)]
struct ReleaseInfo {
    version: String,
    title: String,
    notes: String,
    published: String,
    url: String,
    image: Option<String>,
    size: u64,
    files: usize,
    /// README of the repo (the "all features" page), empty if it couldn't be loaded
    features: String,
    /// None when not installed; true when any installed file differs from the release
    changed: Option<bool>,
    /// set when the mod is switched off for now: install and update are blocked, the text says why
    unavailable: Option<String>,
}

fn file_matches(path: &Path, a: &GhAsset) -> bool {
    let Ok(data) = fs::read(path) else { return false };
    match a.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        Some(want) => hex::encode(Sha256::digest(&data)).eq_ignore_ascii_case(want),
        None => data.len() as u64 == a.size,
    }
}

#[derive(Serialize, Clone)]
struct Progress {
    id: String,
    done: usize,
    total: usize,
}

fn mod_def(id: &str) -> Result<&'static ModDef, String> {
    MODS.iter().find(|m| m.id == id).ok_or_else(|| format!("Unknown mod {id}"))
}

fn version_of_tag(tag: &str) -> String {
    tag.trim_start_matches(['v', 'V']).to_string()
}

// shortcut: folder comes from the file type (the layout both repos use); add a manifest if a mod ever needs another layout
fn target_path(name: &str) -> Option<String> {
    if name.contains(['/', '\\']) || name.contains("..") {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if lower == "mod.json" {
        Some(name.to_string())
    } else if lower.ends_with(".gsc") {
        Some(format!("scripts/{name}"))
    } else if lower.ends_with(".lua") {
        Some(format!("lua/{name}"))
    } else if lower.ends_with(".png") && lower != "preview.png" {
        Some(format!("images/{name}"))
    } else {
        None
    }
}

// ---------- Kronos folder ----------

fn is_kronos_dir(p: &Path) -> bool {
    p.join("custom_scripts").is_dir() || (p.join("mods").is_dir() && p.join("Assets").is_dir())
}

/// Accepts the kronos folder itself, the launcher folder, cod25, or the mods folder.
fn normalize_kronos(p: &Path) -> Option<PathBuf> {
    let candidates = [
        p.to_path_buf(),
        p.join("cod25").join("kronos"),
        p.join("kronos"),
        p.parent().map(Path::to_path_buf).unwrap_or_default(),
    ];
    candidates.into_iter().find(|c| !c.as_os_str().is_empty() && is_kronos_dir(c))
}

fn detect_kronos() -> Option<PathBuf> {
    const SKIP: &[&str] = &["windows", "programdata", "$recycle.bin", "system volume information", "appdata", "node_modules", ".git", "winsxs"];
    let mut stack: Vec<(PathBuf, u32)> = Vec::new();
    for letter in b'C'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        if root.is_dir() {
            stack.push((root, 0));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        for sub in ["Downloads", "Desktop", "Documents"] {
            stack.push((home.join(sub), 1));
        }
    }
    while let Some((dir, depth)) = stack.pop() {
        if dir.join("KronosLauncher.exe").is_file() {
            if let Some(k) = normalize_kronos(&dir) {
                return Some(k);
            }
        }
        if depth >= 3 {
            continue;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if !ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if SKIP.contains(&name.as_str()) {
                continue;
            }
            stack.push((e.path(), depth + 1));
        }
    }
    None
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("config.json"))
}

fn save_config(app: &AppHandle, cfg: &Config) {
    if let Some(f) = config_file(app) {
        let _ = fs::create_dir_all(f.parent().unwrap());
        let _ = fs::write(f, serde_json::to_string_pretty(cfg).unwrap_or_default());
    }
}

fn kronos(state: &State<AppState>) -> Result<PathBuf, String> {
    state.config.lock().unwrap().kronos.clone().ok_or_else(|| "Kronos folder not set".to_string())
}

#[tauri::command]
async fn get_kronos(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let saved = state.config.lock().unwrap().kronos.clone();
    if let Some(p) = saved.filter(|p| is_kronos_dir(p)) {
        return Ok(Some(p.display().to_string()));
    }
    let found = tauri::async_runtime::spawn_blocking(detect_kronos).await.map_err(|e| e.to_string())?;
    let mut cfg = state.config.lock().unwrap();
    cfg.kronos = found.clone();
    save_config(&app, &cfg);
    Ok(found.map(|p| p.display().to_string()))
}

#[tauri::command]
async fn pick_kronos(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("Select your Kronos folder (the one with KronosLauncher.exe)").blocking_pick_folder();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let k = normalize_kronos(&path).ok_or("This is not a Kronos folder. Pick the folder that contains KronosLauncher.exe.")?;
    let mut cfg = state.config.lock().unwrap();
    cfg.kronos = Some(k.clone());
    save_config(&app, &cfg);
    Ok(Some(k.display().to_string()))
}

// ---------- mods ----------

fn installed_version(kronos: &Path, id: &str) -> Option<String> {
    let text = fs::read_to_string(kronos.join("mods").join(id).join("mod.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(v.get("version").and_then(|x| x.as_str()).unwrap_or("?").to_string())
}

#[tauri::command]
fn list_mods(state: State<AppState>) -> Vec<ModInfo> {
    let k = state.config.lock().unwrap().kronos.clone();
    MODS.iter()
        .map(|m| ModInfo {
            id: m.id.into(),
            name: m.name.into(),
            repo: m.repo.into(),
            tagline: m.tagline.into(),
            installed: k.as_deref().and_then(|k| installed_version(k, m.id)),
            conflicts: m.conflicts.iter().map(|c| c.to_string()).collect(),
        })
        .collect()
}

async fn latest_release(http: &reqwest::Client, repo: &str) -> Result<GhRelease, String> {
    let resp = http
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Can't reach GitHub: {e}"))?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN || resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("GitHub rate limit reached, try again in a few minutes.".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}", resp.status()));
    }
    resp.json().await.map_err(|e| format!("Bad answer from GitHub: {e}"))
}

async fn readme(http: &reqwest::Client, repo: &str) -> Option<String> {
    let resp = http
        .get(format!("https://api.github.com/repos/{repo}/readme"))
        .header("Accept", "application/vnd.github.raw")
        .send()
        .await
        .ok()?;
    resp.error_for_status().ok()?.text().await.ok()
}

// mods paused from GitHub ({"id": "reason"} in the fuzmods repo), so one comes back without a FuzMods release; unreadable = available
async fn unavailable_reason(http: &reqwest::Client, id: &str) -> Option<String> {
    let v: serde_json::Value = http
        .get("https://raw.githubusercontent.com/Fuzion28/fuzmods/main/unavailable.json")
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    v.get(id)?.as_str().map(String::from)
}

#[tauri::command]
async fn fetch_release(id: String, state: State<'_, AppState>) -> Result<ReleaseInfo, String> {
    let def = mod_def(&id)?;
    let rel = latest_release(&state.http, def.repo).await?;
    let files: Vec<(&GhAsset, String)> = rel.assets.iter().filter_map(|a| target_path(&a.name).map(|t| (a, t))).collect();
    let mod_dir = state.config.lock().unwrap().kronos.clone().map(|k| k.join("mods").join(def.id));
    let changed = match mod_dir.filter(|d| d.join("mod.json").is_file()) {
        Some(dir) => {
            let files: Vec<(GhAsset, String)> = files.iter().map(|(a, t)| ((*a).clone(), t.clone())).collect();
            Some(tauri::async_runtime::spawn_blocking(move || files.iter().any(|(a, t)| !file_matches(&dir.join(t), a))).await.map_err(|e| e.to_string())?)
        }
        None => None,
    };
    let features = readme(&state.http, def.repo).await.unwrap_or_default();
    let unavailable = unavailable_reason(&state.http, def.id).await;
    Ok(ReleaseInfo {
        features,
        version: version_of_tag(&rel.tag_name),
        title: rel.name.clone().unwrap_or_else(|| rel.tag_name.clone()),
        notes: rel.body.clone().unwrap_or_default(),
        published: rel.published_at.clone().unwrap_or_default(),
        url: rel.html_url.clone(),
        image: rel.assets.iter().find(|a| a.name == def.image).map(|a| a.browser_download_url.clone()),
        size: files.iter().map(|(a, _)| a.size).sum(),
        files: files.len(),
        changed,
        unavailable,
    })
}

async fn download(http: &reqwest::Client, a: &GhAsset, dest: &Path) -> Result<(), String> {
    let bytes = http
        .get(&a.browser_download_url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("{}: {e}", a.name))?
        .bytes()
        .await
        .map_err(|e| format!("{}: {e}", a.name))?;
    if bytes.len() as u64 != a.size {
        return Err(format!("{}: download is incomplete", a.name));
    }
    if let Some(want) = a.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        let got = hex::encode(Sha256::digest(&bytes));
        if !got.eq_ignore_ascii_case(want) {
            return Err(format!("{}: file is corrupted (checksum mismatch)", a.name));
        }
    }
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(dest, &bytes).map_err(|e| format!("{}: {e}", a.name))
}

fn in_use_hint(e: std::io::Error) -> String {
    format!("Could not replace the mod files ({e}). Close the game and Kronos, then try again.")
}

#[tauri::command]
async fn install(app: AppHandle, id: String, state: State<'_, AppState>) -> Result<String, String> {
    let def = mod_def(&id)?;
    let k = kronos(&state)?;
    let v = install_into(&state.http, &k, def, |done, total| {
        let _ = app.emit("progress", Progress { id: id.clone(), done, total });
    })
    .await?;
    remove_conflicts(&k, def)?;
    Ok(v)
}

fn remove_conflicts(k: &Path, def: &ModDef) -> Result<(), String> {
    for c in def.conflicts {
        let dir = k.join("mods").join(c);
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| format!("{} was installed, but {c} could not be removed ({e}). Close the game and Kronos, then uninstall it.", def.name))?;
        }
    }
    Ok(())
}

async fn install_into(http: &reqwest::Client, k: &Path, def: &ModDef, progress: impl Fn(usize, usize)) -> Result<String, String> {
    let id = def.id;
    let rel = latest_release(http, def.repo).await?;
    let files: Vec<(GhAsset, String)> = rel.assets.iter().filter_map(|a| target_path(&a.name).map(|t| (a.clone(), t))).collect();
    if !files.iter().any(|(_, t)| t == "mod.json") {
        return Err("This release has no mod.json, it can't be installed.".into());
    }

    // stage next to mods/ (same drive, so the final swap is a rename) but outside it, so Kronos never loads a half-done copy
    let work = k.join(".fuzmods");
    let staging = work.join(format!("{id}-new"));
    let backup = work.join(format!("{id}-old"));
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_dir_all(&backup);
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let total = files.len();
    progress(0, total);
    let mut done = 0;
    let jobs: Vec<_> = files.iter().map(|(a, t)| (http.clone(), a.clone(), staging.join(t))).collect();
    let mut results = stream::iter(jobs.into_iter().map(|(http, a, dest)| async move { download(&http, &a, &dest).await }))
        .buffer_unordered(8);
    while let Some(r) = results.next().await {
        if let Err(e) = r {
            drop(results);
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
        done += 1;
        progress(done, total);
    }
    drop(results);

    let target = k.join("mods").join(id);
    fs::create_dir_all(k.join("mods")).map_err(|e| e.to_string())?;
    if target.exists() {
        fs::rename(&target, &backup).map_err(in_use_hint)?;
    }
    if let Err(e) = fs::rename(&staging, &target) {
        let _ = fs::rename(&backup, &target); // put the old version back
        return Err(in_use_hint(e));
    }
    let _ = fs::remove_dir_all(&backup);
    let _ = fs::remove_dir(&work);
    Ok(installed_version(k, id).unwrap_or_else(|| version_of_tag(&rel.tag_name)))
}

#[tauri::command]
fn uninstall(id: String, state: State<AppState>) -> Result<(), String> {
    mod_def(&id)?;
    let target = kronos(&state)?.join("mods").join(&id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(in_use_hint)?;
    }
    Ok(())
}

#[tauri::command]
fn open_folder(id: Option<String>, state: State<AppState>) -> Result<(), String> {
    let k = kronos(&state)?;
    let dir = match id {
        Some(id) => k.join("mods").join(mod_def(&id)?.id),
        None => k,
    };
    std::process::Command::new("explorer").arg(&dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/") {
        return Err("Blocked link".into());
    }
    std::process::Command::new("explorer").arg(&url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn launch_kronos(state: State<AppState>) -> Result<(), String> {
    let k = kronos(&state)?;
    let launcher = k.ancestors().map(|d| d.join("KronosLauncher.exe")).find(|p| p.is_file()).ok_or("KronosLauncher.exe not found next to your Kronos folder.")?;
    std::process::Command::new(&launcher).current_dir(launcher.parent().unwrap()).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- self update ----------
const SELF_REPO: &str = "Fuzion28/fuzmods";
const SELF_ASSET: &str = "FuzMods.exe";

/// true when version a is newer than b ("1.10.0" > "1.9.2")
fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split('.').map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}

#[derive(Serialize)]
struct SelfUpdate {
    version: String,
    notes: String,
}

#[tauri::command]
async fn check_self_update(state: State<'_, AppState>) -> Result<Option<SelfUpdate>, String> {
    let rel = latest_release(&state.http, SELF_REPO).await?;
    let version = version_of_tag(&rel.tag_name);
    if !newer(&version, env!("CARGO_PKG_VERSION")) || !rel.assets.iter().any(|a| a.name == SELF_ASSET) {
        return Ok(None);
    }
    Ok(Some(SelfUpdate { version, notes: rel.body.unwrap_or_default() }))
}

#[tauri::command]
async fn self_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let rel = latest_release(&state.http, SELF_REPO).await?;
    let asset = rel.assets.iter().find(|a| a.name == SELF_ASSET).ok_or("The new version has no FuzMods.exe.")?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let new = exe.with_extension("exe.new");
    download(&state.http, asset, &new).await?; // size and sha256 checked
    // Windows lets a running exe be renamed, not overwritten: move it aside, put the new one in its place
    let old = exe.with_extension("exe.old");
    let _ = fs::remove_file(&old);
    let fail = |e: std::io::Error| format!("Could not replace FuzMods ({e}). Download the new version from GitHub.");
    fs::rename(&exe, &old).map_err(fail)?;
    if let Err(e) = fs::rename(&new, &exe) {
        let _ = fs::rename(&old, &exe);
        return Err(fail(e));
    }
    std::process::Command::new(&exe).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

fn main() {
    // remove the previous exe left by a self update, once it has exited
    if let Ok(exe) = std::env::current_exe() {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(3));
            let _ = fs::remove_file(exe.with_extension("exe.old"));
            let _ = fs::remove_file(exe.with_extension("exe.new"));
        });
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = config_file(app.handle())
                .and_then(|f| fs::read_to_string(f).ok())
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default();
            let http = reqwest::Client::builder().user_agent("FuzMods").build()?;
            app.manage(AppState { config: Mutex::new(config), http });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_kronos, pick_kronos, list_mods, fetch_release, install, uninstall, open_folder, open_url, launch_kronos, check_self_update, self_update])
        .run(tauri::generate_context!())
        .expect("error while running FuzMods");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(newer("1.1.0", "1.0.0"));
        assert!(newer("1.10.0", "1.9.9"));
        assert!(newer("2.0", "1.9.9"));
        assert!(!newer("1.1.0", "1.1.0"));
        assert!(!newer("1.0.9", "1.1.0"));
    }

    #[test]
    fn targets() {
        assert_eq!(target_path("mod.json").as_deref(), Some("mod.json"));
        assert_eq!(target_path("zm_mod_menu.gsc").as_deref(), Some("scripts/zm_mod_menu.gsc"));
        assert_eq!(target_path("zm_splitter_post.lua").as_deref(), Some("lua/zm_splitter_post.lua"));
        assert_eq!(target_path("fuzmenu_bg.png").as_deref(), Some("images/fuzmenu_bg.png"));
        assert_eq!(target_path("preview.png"), None);
        assert_eq!(target_path("FuzMenu_v2.6.0.rar"), None);
        assert_eq!(target_path("../evil.lua"), None);
        assert_eq!(version_of_tag("v2.6.0"), "2.6.0");
    }

    #[test]
    fn finds_kronos_from_launcher_dir() {
        let k = Path::new(r"D:\Games\Kronus");
        if k.is_dir() {
            assert_eq!(normalize_kronos(k), Some(k.join("cod25").join("kronos")));
        }
    }

    // network test: cargo test -- --ignored
    #[test]
    #[ignore]
    fn installs_and_updates_from_github() {
        let k = std::env::temp_dir().join("fuzmods_test_kronos");
        let _ = fs::remove_dir_all(&k);
        fs::create_dir_all(k.join("custom_scripts")).unwrap();
        let http = reqwest::Client::builder().user_agent("FuzMods").build().unwrap();
        let rt = tauri::async_runtime::block_on(async {
            for def in MODS {
                let calls = std::sync::atomic::AtomicUsize::new(0);
                let v = install_into(&http, &k, def, |_, _| { calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }).await.unwrap();
                let rel = latest_release(&http, def.repo).await.unwrap();
                assert_eq!(v, version_of_tag(&rel.tag_name));
                let dir = k.join("mods").join(def.id);
                let files: Vec<_> = rel.assets.iter().filter_map(|a| target_path(&a.name).map(|t| (a, t))).collect();
                assert!(files.iter().all(|(a, t)| file_matches(&dir.join(t), a)), "{} files differ after install", def.id);
                assert!(calls.into_inner() > files.len());
                // tamper one file: it must show as changed, then a reinstall repairs it
                fs::write(dir.join("mod.json"), "{}").unwrap();
                assert!(!files.iter().all(|(a, t)| file_matches(&dir.join(t), a)));
                install_into(&http, &k, def, |_, _| {}).await.unwrap();
                assert!(files.iter().all(|(a, t)| file_matches(&dir.join(t), a)));
                println!("{} v{} ok, {} files", def.id, v, files.len());
            }
            assert!(readme(&http, MODS[0].repo).await.is_some_and(|r| r.contains("FuzMenu")));
        });
        // both are installed now: installing FuzSpeedrun last must remove FuzMenu
        remove_conflicts(&k, &MODS[1]).unwrap();
        assert!(!k.join("mods").join("fuzmenu").exists() && k.join("mods").join("fuzspeedrun").exists());
        assert!(!k.join(".fuzmods").exists());
        let _ = rt;
        fs::remove_dir_all(&k).unwrap();
    }
}
