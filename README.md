<p align="center">
  <img src=".github/assets/logo.png" width="128" alt="Casualties Manageable">
</p>
<h1 align="center">Metadata</h1>

<p align="center">
  This repository contains the metadata used by <a href="https://github.com/CasualtiesManageable/CasualtiesManageable">Casualties Manageable</a> to discover and display mods for <a href="https://store.steampowered.com/app/4576490/Casualties_Unknown/">Casualties: Unknown</a> game.
</p>

<p align="center">
  <a href="https://discord.gg/qWqdKg9cdC">
    <img src="https://img.shields.io/badge/Discord-%235865F2.svg?style=for-the-badge&logo=discord&logoColor=white" alt="Discord">
  </a>
  <a href="https://ko-fi.com/nomodev">
    <img src="https://img.shields.io/badge/Ko--fi-%23F16061.svg?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi">
  </a>
</p>

---

## Adding Your Mod

To submit your mod to the launcher, open a **Pull Request** that adds your entry to `mods.json`.

### Requirements

Before submitting, make sure:

- Your mod targets **BepInEx 5** and works with the game version you specify in `requiredGameVersion`
- Your `id` is unique and follows reverse-domain notation: `com.yourname.modname`
- Your `downloadUrl` points to a **stable release asset** (not a branch/commit zip)

### Mod Entry Schema

Add your entry to the array in `mods.json`:

```jsonc
{
  "id": "com.yourname.modname",          // Required. Unique reverse-domain ID
  "name": "Your Mod Name",               // Required. Display name shown in the launcher
  "version": "1.0.0",                    // Required. Must match your latest release tag
  "description": "What your mod does.",  // Required. Short description (1–2 sentences)
  "author": "YourName",                  // Required. Your display name or GitHub username
  "requiredGameVersion": "7.0.1",        // Required. Minimum compatible game version

  "links": {
    "icon": "https://...",               // Optional. Direct URL to your mod's icon image
    "source": "https://github.com/...",  // Optional. Link to your source repository
    "support": "https://discord.gg/...", // Optional. Discord or forum support link
    "donate": "https://..."              // Optional. Donation link
  },

  "download": {
    "downloadUrl": "https://github.com/.../releases/download/v1.0.0/Plugin.zip",
    // Avoid if possible, structure your .zip to extract cleanly into the game root instead.
    // Only use if your archive has mod content inside a specific subfolder.
    // "customArchiveMapping": {
    //   "FolderInsideZip": "BepInEx\\plugins"   // source (inside zip) → destination (relative to game root)
    // }
  }
}
```
 
### Installation Behavior
 
The recommended approach is to provide either:
 
- A **`.zip`** archive structured so it can be extracted directly into the game root folder as-is
- A **`.dll`** file, which the launcher will copy into `BepInEx/plugins/` automatically

### `customArchiveMapping` (advanced)
 
> ⚠️ Avoid this unless necessary. Structure your `.zip` to extract cleanly into the game root instead.
 
If your archive has a non-standard layout, use `customArchiveMapping` to define how its contents are placed. Each entry maps a **path inside the zip** (key) to a **destination path relative to the game root** (value):
 
```jsonc
"download": {
  "downloadUrl": "https://...",
  "customArchiveMapping": {
    "mod": "BepInEx\\plugins"   // key   = folder/file inside the zip
                                // value = destination relative to game root
                                //         empty string "" = root
  }
}
```

---

## Keeping Your Mod Up to Date

When you release a new version of your mod, open a PR that updates both:

- `"version"` - to your new version string
- `"requiredGameVersion"` - to new game version if necessary
- `"downloadUrl"` - to the new release asset URL

The launcher uses `version` to detect available updates and shows a button to users when a newer version is available.

---

## Pull Request Guidelines

- One mod per PR
- PR title: `Add [Mod Name]` or `Update [Mod Name] to vX.Y.Z`
- Validate your JSON before submitting!
- Do not reformat the entire file; only add or modify your own entry

---

## License

The metadata in this repository is provided under the [MIT License](LICENSE).  
Each mod is subject to its own license as specified by its author.