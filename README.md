# FuzMods

A small Windows app to install and update **FuzMenu** and **FuzSpeedrun** for BO7 Zombies on Kronos.

![FuzMods](app-icon.png)

## Download

Get `FuzMods.exe` from the [latest release](https://github.com/Fuzion28/fuzmods/releases/latest). No install needed, just run it.

## Features

- Finds your Kronos folder automatically (or pick it with Browse)
- One click install, update and uninstall for FuzMenu and FuzSpeedrun
- Detects updates by comparing every installed file with the latest GitHub release
- Every download is checked (size and SHA-256) before the mod is replaced; if anything fails, the old version is restored
- Your settings, builds, Forge saves and personal bests are never touched
- FuzMenu and FuzSpeedrun can't be installed together (FuzMenu already includes the speedrun timer): installing one removes the other
- **All features** tab with the full feature list of each mod
- Release notes for each mod, and a Launch Kronos button
- Resizable window with maximize
- Updates itself: when a new FuzMods is out, an Update button shows in the title bar

## Notes

- Close the game and Kronos before installing or updating.
- The exe is not code signed, so Windows SmartScreen or some antivirus may warn about it. The full source is in this repo.

## Build from source

Needs Rust and Node.js.

```
npm install
npx tauri build
```

The exe is written to `src-tauri/target/release/fuzmods.exe`.
