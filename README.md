<p align="center">
  <img src=".github/assets/logo.png" width="128" alt="Casualties Manageable">
</p>
<h1 align="center">Metadata</h1>

<p align="center">
  This repository contains the metadata used for couple of my (and other people's!) <a href="https://store.steampowered.com/app/4576490/Casualties_Unknown/">Casualties: Unknown</a>-related projects, including:
</p>
  
* Several mod managers
* Shields.io badges for nexus download counts
* What Mod Is This From? (WMITF) metadata
* Webapp locale <-> id conversion data
  

# Stuff!

### Metadata
Every hour, this repository checks for any changes to a nexusmod mod with the API. If so, it downloads the file using the premium API key and parses the mod for data otherwise unrevealed by nexus' own api (e.g. SHA hashes, BepInPlugin version, etc..)

The data is stored in [nexusmods.json](https://github.com/jimmyking9999999/Metadata-generator/blob/main/nexusmods.json). Note a direct download link cannot be provided, as it is against Nexus' own TOS and Fair Use polices, nor can direct mod files be hosted here due the the independent mod author's licensing.

See [https://discord.gg/ehCptz9pwU](https://discord.gg/ehCptz9pwU) for an announcement channel for new mod listings and mod updates, using this metadata.

---
### Badges
Also automated to update hourly-ish, `badges/` is a complete Shields endpoint response with the Nexus Mods icon

#### Markdown (Github) Badge:
```md
[![Nexus Downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjimmyking9999999%2FMetadata-generator%2Fmain%2Fbadges%2Fcucorelib.json)](https://www.nexusmods.com/scavprototype/mods/341)
```

#### BBCode (NexusMods) Badge:
```md
[url=https://www.nexusmods.com/scavprototype/mods/341][img]https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjimmyking9999999%2FMetadata-generator%2Fmain%2Fbadges%2Fcucorelib.json[/img][/url]
```
To use, simply change the cucorelib.json to your mod's name of choice, then remove or adjust the hyperlink to your mod ID (replace spaces with hyphens -)

Note: Badge files use the normalized Nexus mod name: lowercase, with words separated by hyphens. For example, CUCoreLib is `badges/cucorelib.json`:

<center> 
  
[![Nexus Downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjimmyking9999999%2FMetadata-generator%2Fmain%2Fbadges%2Fcucorelib.json)](https://www.nexusmods.com/scavprototype/mods/341) </center>

---
### What Mod Is This From? (WMITF) data
[WMITF-metadata.json](https://github.com/jimmyking9999999/Metadata-generator/blob/main/WMITF-metadata.json) is a list of non-CUCoreLib/RshLib based mod data to be integrated into [What Mod Is This From?](https://www.nexusmods.com/scavprototype/mods/552). 

Supported fields:
```html 
"guid": "ModGuidCaseSensitive",
      "items": [],
      "tiles": [],
      "buildingEntities": [],
      "liquids": [],
      "recipes": [],
      "tileRanges": [] 
```

No matter if you are a player or developer of a unsupported mod, you are absolutely welcome to make a PR to add your favourite/own mod onto this list :)

---
### Locale

Meant for mods such as Plushies Plus! and [Custom Structures](https://cu-custom-structures.jimmyking.dev/) which have an online component, this [.json file](https://github.com/jimmyking9999999/Metadata-generator/blob/main/scavgame-locale-id-names.json) is meant as a way to easily 
- Get a updated list of items/buildingentites/game resources
- Allow the user to input a game id (e.g. the same as the in-game `spawn` command) and output the display name
- Or ^ in reverse!

---
### Website

Cool thing here soon. No peeking!

---

# License

The metadata in this repository is provided under the [MIT License](LICENSE). Use it for your own projects at will~

Each mod is subject to its own license as specified by its author.
