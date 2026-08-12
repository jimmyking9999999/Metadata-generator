import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import { createExtractorFromFile } from "node-unrar-js";
import sevenZip from "node-7z";
import sevenBin from "7zip-bin";

const { extractFull } = sevenZip;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = await resolveRepoRoot();
const NEXUSMODS_PATH = path.join(REPO_ROOT, "nexusmods.json");
const BADGES_PATH = path.join(REPO_ROOT, "badges");
const PACKAGE_PATH = path.join(REPO_ROOT, "package.json");
const TEMP_ROOT = path.join(os.tmpdir(), "metadata-nexusmods");

const API_BASE_URL = "https://api.nexusmods.com/v1";
const GRAPHQL_API_URL = "https://api.nexusmods.com/v2/graphql";
const V3_API_BASE_URL = "https://api.nexusmods.com/v3";
const APP_NAME = "Metadata Nexus Sync";
const REQUEST_TIMEOUT_MS = 60_000;
const FULL_RECENT_PERIODS = ["1d", "1w", "1m"];
const QUICK_DISCOVERY_ROUTES = [
  "/mods/latest_added",
  "/mods/latest_updated",
];
const MAX_MOD_LOG_DESCRIPTION = 120;
const DOWNLOADABLE_EXTENSIONS = new Set([".zip", ".7z", ".rar"]);
const DISCORD_COLORS = {
  created: 0x57f287,
  updated: 0x5865f2,
};
const DISCORD_USERNAME = "Nexus Mod Updates";
const DISCORD_AVATAR_URL = "https://media.discordapp.net/attachments/1360921920530546971/1519722372012310640/favicon.png?ex=6a3e9740&is=6a3d45c0&hm=ced53232a41abfd5ed21c3d32c3df5eac5a76a457399ba19e35f452059195ce3&=&format=webp&quality=lossless";
const ADULT_MOD_MESSAGE = "Adult Mod! ||[.](https://cdn.discordapp.com/attachments/1519387321231737022/1535621586542133308/image.png?ex=6a786e8c&is=6a771d0c&hm=c8cd455200291b177c5c346d73fd46623b6301dc57bbd45b757b54067f01f5ce&)||";
const NEXUS_MODS_LOGO_SVG = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="white" d="M17.376 0c-.993 0-2.18.686-2.907 1.182-1.676-.36-4.036-.545-6.787.635-1.365-.513-2.425-.562-3.32-.488a2.16 2.16 0 0 0-1.27.429c-.33.22-2.788 2.69-3.069 4.652C-.15 7.508.68 8.932 1.218 9.718c-.44 1.76-.2 4.572.517 6.188-.353 1.041-.713 2.089-.664 3.205.01.584.061 1.188.398 1.684C1.72 21.19 4.528 24 6.545 24c.957 0 1.93-.428 3.07-1.24 2.16.383 4.402.348 6.448-.532 2.573 1.001 4.224.625 4.84.162.587-.457 2.826-2.915 3.07-4.622.1-.672-.023-1.638-1.226-3.397a10.983 10.983 0 0 0-.501-6.455c.396-1.069.673-2.188.59-3.337-.015-.68-.221-1.167-.487-1.507-.209-.335-2.415-2.39-4.028-2.91A3.105 3.105 0 0 0 17.376 0m-.03 2.082c.65.015 2.155 1.093 3.01 1.906l.355.34c-.959-.163-2.125.428-3.26 1.55a10.28 10.28 0 0 0-1.358 1.595c-.28.384-.517.768-.753 1.285l1.18.635-3.895 1.477-1.122-4.18 1.033.547c1.358-3.102 2.524-3.973 3.232-4.416h.015a5.12 5.12 0 0 1 1.49-.724zM12 3.065a8.932 8.932 0 0 1 2.22.279 7.67 7.67 0 0 0-.42.488 8.403 8.403 0 0 0-1.8-.196 8.336 8.336 0 0 0-5.897 2.432 7.86 7.86 0 0 1-.37-.433A8.905 8.905 0 0 1 12 3.065m-7.076.305c.71-.002 1.309.127 2.2.466a9.526 9.526 0 0 0-1.713 1.337c-.327-.542-.624-1.156-.488-1.803m-.606.042c-.162.96.428 2.126 1.55 3.264.457.487 1.003.945 1.594 1.358.383.281.767.517 1.283.754l.62-1.182 1.49 3.914-4.176 1.122.546-1.033c-3.099-1.36-3.969-2.526-4.412-3.235v-.015a5.144 5.144 0 0 1-.723-1.491l-.015-.074c.015-.65 1.092-2.156 1.904-3.013Zm16.035 1.483a1.259 1.259 0 0 1 .26.015l.14.023a5.05 5.05 0 0 1-.13 1.137v.015c-.1.383-.228.765-.377 1.148a9.526 9.526 0 0 0-1.346-1.776c.547-.357 1.051-.546 1.453-.562M18.43 5.8a8.903 8.903 0 0 1 2.506 6.2 8.937 8.937 0 0 1-.27 2.183 7.658 7.658 0 0 0-.488-.425A8.407 8.407 0 0 0 20.364 12 8.334 8.334 0 0 0 18 6.173a7.904 7.904 0 0 1 .429-.373M3.315 9.905c.157.148.319.29.488.425A8.417 8.417 0 0 0 3.636 12c0 2.248.887 4.286 2.327 5.788a8.11 8.11 0 0 1-.426.376A8.902 8.902 0 0 1 3.065 12a8.937 8.937 0 0 1 .25-2.095m13.988 1.541-.546 1.034c3.098 1.359 3.969 2.526 4.412 3.235v.014c.34.488.575.99.723 1.492l.014.074c-.014.65-1.092 2.156-1.903 3.013l-.34.354c.163-.96-.427-2.127-1.549-3.264a10.298 10.298 0 0 0-1.594-1.359 7.008 7.008 0 0 0-1.283-.753l-.605 1.152-1.505-3.87zm-6.006 1.684 1.121 4.18-1.033-.547c-1.357 3.102-2.523 3.973-3.231 4.416h-.015c-.487.34-.989.576-1.49.724l-.074.015c-.65-.015-2.154-1.093-3.01-1.906l-.354-.34c.959.163 2.124-.428 3.26-1.55.488-.458.945-1.004 1.358-1.595.28-.384.517-.768.753-1.285l-1.166-.635ZM3.72 16.663A9.526 9.526 0 0 0 5.086 18.5c-.697.47-1.33.665-1.777.59l-.138-.024c0-.367.038-.748.128-1.137v-.015c.11-.417.254-.835.42-1.252m14.131 1.314c.129.14.253.283.372.43A8.904 8.904 0 0 1 12 20.936a8.932 8.932 0 0 1-2.282-.296 7.757 7.757 0 0 0 .417-.487 8.335 8.335 0 0 0 7.716-2.175m.696.889c.43.666.607 1.267.534 1.698l-.023.138a5.034 5.034 0 0 1-1.136-.128h-.014a10.718 10.718 0 0 1-1.114-.366 9.526 9.526 0 0 0 1.753-1.342"/></svg>';
const OWNED_FIELDS = new Set([
  "Id",
  "Name",
  "Version",
  "bepinexVersion",
  "Description",
  "Author",
  "Links",
  "DownloadUrl",
  "NexusGameDomain",
  "NexusModId",
  "SourceName",
  "ContainsAdultContent",
  "LastUpdated",
  "ReleaseDate",
  "SHA256",
  "dllSHA256s",
  "downloadsSinceLatestVersion",
  "Dependencies",
  "dllNames",
  "dllVersion",
  "dllVersions",
  "Statistics",
  "Images",
]);
const TRACKED_LOG_FIELDS = [
  "Id",
  "Name",
  "Version",
  "bepinexVersion",
  "Description",
  "Author",
  "Links.Icon",
  "Links.NexusMods",
  "DownloadUrl",
  "NexusGameDomain",
  "NexusModId",
  "ContainsAdultContent",
  "LastUpdated",
  "ReleaseDate",
  "SHA256",
  "dllSHA256s",
  "downloadsSinceLatestVersion",
  "Dependencies",
  "dllNames",
  "dllVersion",
  "dllVersions",
  "Statistics.Endorsements",
  "Statistics.UniqueDownloads",
  "Statistics.TotalDownloads",
  "Statistics.TotalViews",
  "Images",
];
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[97m",
};

let cachedMonoCecilPath = null;

async function resolveRepoRoot() {
  const candidates = await collectRepoRootCandidates();
  for (const candidate of candidates) {
    if (await fileExists(path.join(candidate, "nexusmods.json")) && await fileExists(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }

  throw new Error(`Could not locate repo root containing nexusmods.json and package.json. Tried: ${candidates.join(", ")}`);
}

async function collectRepoRootCandidates() {
  const starts = [SCRIPT_ROOT, process.cwd()];
  const seen = new Set();
  const results = [];

  for (const start of starts) {
    let current = path.resolve(start);
    while (true) {
      if (!seen.has(current)) {
        seen.add(current);
        results.push(current);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return results;
}

async function fileExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NEXUS_API_KEY environment variable.");
  }

  const runMode = getRunMode(process.argv.slice(2));
  await mkdir(TEMP_ROOT, { recursive: true });

  const packageJson = JSON.parse(await readFile(PACKAGE_PATH, "utf8"));
  const appVersion = packageJson.version;
  const entries = JSON.parse(await readFile(NEXUSMODS_PATH, "utf8"));

  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("nexusmods.json must contain a non-empty top-level array.");
  }

  const gameDomains = [...new Set(entries.map((entry) => entry?.NexusGameDomain).filter(Boolean))];
  if (gameDomains.length === 0) {
    throw new Error("No NexusGameDomain values were found in nexusmods.json.");
  }

  logBanner(`Nexus Mods Archive Sync (${runMode})`);
  logInfo(`Loaded ${entries.length} existing entries.`);
  logInfo(`Refreshing game domains: ${gameDomains.join(", ")}`);

  await validateApiKey(apiKey, appVersion);
  logSuccess("Nexus API key validated.");

  const nonNexusEntries = entries.filter((entry) => !(Number.isInteger(entry?.NexusModId) && entry?.NexusGameDomain));
  const entryByKey = new Map();
  for (const entry of entries) {
    if (Number.isInteger(entry?.NexusModId) && entry?.NexusGameDomain) {
      entryByKey.set(getEntryKey(entry.NexusGameDomain, entry.NexusModId), entry);
    }
  }

  if (runMode === "full") {
    await runFullSync({
      apiKey,
      appVersion,
      gameDomains,
      entryByKey,
    });
  } else {
    await runQuickSync({
      apiKey,
      appVersion,
      gameDomains,
      entryByKey,
    });
  }

  const nextEntries = [
    ...nonNexusEntries,
    ...[...entryByKey.values()].sort(compareEntries),
  ];
  const nextJson = `${JSON.stringify(nextEntries, null, 4)}\n`;
  const catalogChanged = await writeFileIfChanged(NEXUSMODS_PATH, nextJson);
  const badgeChanges = await writeNexusBadges(nextEntries);

  if (!catalogChanged && badgeChanges === 0) {
    logInfo("nexusmods.json and badges are already up to date.");
    return;
  }

  if (catalogChanged) {
    logSuccess("Updated nexusmods.json");
  }
  if (badgeChanges > 0) {
    logSuccess(`Updated ${badgeChanges} badge file${badgeChanges === 1 ? "" : "s"}.`);
  }
}

async function exportNexusBadges() {
  const entries = JSON.parse(await readFile(NEXUSMODS_PATH, "utf8"));
  if (!Array.isArray(entries)) {
    throw new Error("nexusmods.json must contain a top-level array.");
  }

  const badgeChanges = await writeNexusBadges(entries);
  if (badgeChanges > 0) {
    logSuccess(`Updated ${badgeChanges} badge file${badgeChanges === 1 ? "" : "s"}.`);
  } else {
    logInfo("Badges are already up to date.");
  }
}

async function writeNexusBadges(entries) {
  const badges = buildNexusBadges(entries);
  const expectedNames = new Set(badges.map((badge) => badge.fileName));
  let changes = 0;

  await mkdir(BADGES_PATH, { recursive: true });
  for (const badge of badges) {
    const badgeJson = `${JSON.stringify({
      schemaVersion: 1,
      label: "Nexus Downloads",
      message: formatDownloadCount(badge.downloads),
      color: "DA8E35",
      logoSvg: NEXUS_MODS_LOGO_SVG,
    }, null, 2)}\n`;
    if (await writeFileIfChanged(path.join(BADGES_PATH, badge.fileName), badgeJson)) {
      changes += 1;
    }
  }

  for (const entry of await readdir(BADGES_PATH, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !expectedNames.has(entry.name)) {
      await rm(path.join(BADGES_PATH, entry.name));
      changes += 1;
    }
  }

  return changes;
}

function buildNexusBadges(entries) {
  const badges = entries
    .filter((entry) => Number.isInteger(entry?.NexusModId) && entry.NexusModId >= 0)
    .map((entry) => ({
      modId: entry.NexusModId,
      name: typeof entry?.Name === "string" && entry.Name.trim() ? entry.Name.trim() : `mod-${entry.NexusModId}`,
      downloads: typeof entry?.Statistics?.TotalDownloads === "number" && Number.isFinite(entry.Statistics.TotalDownloads)
        ? entry.Statistics.TotalDownloads
        : null,
    }));
  const countsByBaseName = new Map();

  for (const badge of badges) {
    badge.baseName = toBadgeFileName(badge.name);
    countsByBaseName.set(badge.baseName, (countsByBaseName.get(badge.baseName) ?? 0) + 1);
  }

  return badges
    .map((badge) => ({
      ...badge,
      fileName: `${badge.baseName}${countsByBaseName.get(badge.baseName) > 1 ? `-${badge.modId}` : ""}.json`,
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function toBadgeFileName(name) {
  const normalized = name.normalize("NFKD").replace(/\p{Mark}/gu, "");
  const fileName = normalized.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return fileName || "unnamed-mod";
}

function formatDownloadCount(downloads) {
  if (downloads === null) {
    return "unknown";
  }
  if (downloads < 1000) {
    return String(downloads);
  }
  if (downloads < 1_000_000) {
    const thousands = Math.round(downloads / 1000);
    return thousands >= 1000 ? "1M" : `${formatCompactNumber(downloads / 1000)}k`;
  }
  return `${formatCompactNumber(downloads / 1_000_000)}M`;
}

function formatCompactNumber(value) {
  return value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "");
}

async function writeFileIfChanged(targetPath, contents) {
  let currentContents = null;
  try {
    currentContents = await readFile(targetPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (currentContents === contents) {
    return false;
  }

  await writeFile(targetPath, contents, "utf8");
  return true;
}

function getRunMode(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode" && index + 1 < args.length) {
      return normalizeRunMode(args[index + 1]);
    }
    if (arg.startsWith("--mode=")) {
      return normalizeRunMode(arg.slice("--mode=".length));
    }
  }
  return "quick";
}

function normalizeRunMode(value) {
  return String(value).trim().toLowerCase() === "full" ? "full" : "quick";
}

async function runQuickSync({ apiKey, appVersion, gameDomains, entryByKey }) {
  for (const gameDomain of gameDomains) {
    logSection(`Quick Check ${gameDomain}`);
    const candidateMods = await discoverRecentModsForGame(apiKey, appVersion, gameDomain);
    const existingModIds = getExistingModIdsForGame(entryByKey, gameDomain);
    const candidateModIds = new Set(existingModIds);

    for (const item of candidateMods) {
      if (Number.isInteger(item?.mod_id)) {
        candidateModIds.add(item.mod_id);
      }
    }

    logInfo(`Tracked mods to scan: ${existingModIds.length}`);
    logInfo(`Recent candidate mods: ${candidateMods.length}`);
    logInfo(`Quick scan set: ${candidateModIds.size}`);

    for (const modId of [...candidateModIds].sort((a, b) => b - a)) {
      const entryKey = getEntryKey(gameDomain, modId);
      const existingEntry = entryByKey.get(entryKey);

      try {
        logStep(`Checking mod ${modId}`);
        const modInfo = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}`, apiKey, appVersion);
        const nextVersion = modInfo.version ?? existingEntry?.Version ?? "";
        const isNewRelease = existingEntry === undefined;
        const hasNexusVersionChange = !isNewRelease && !areEqual(existingEntry?.Version, nextVersion);

        if (!isNewRelease && !hasNexusVersionChange) {
          await refreshLatestFileDownloads({
            apiKey,
            appVersion,
            gameDomain,
            modId,
            modInfo,
            existingEntry,
            entryByKey,
          });
          continue;
        }

        await refreshModAndNotify({
          apiKey,
          appVersion,
          gameDomain,
          modId,
          modInfo,
          existingEntry,
          entryByKey,
        });
      } catch (error) {
        if (isUnavailableModError(error)) {
          logWarn("UNAVAILABLE", `Skipping unavailable recent mod ${modId}.`);
          continue;
        }

        if (existingEntry) {
          logWarn("MOD_FAIL", `Quick check failed for mod ${modId}; keeping existing entry. ${error.message}`);
        } else {
          logWarn("MOD_FAIL", `Quick check failed for new mod ${modId}; skipping entry. ${error.message}`);
        }
      }
    }
  }
}

async function runFullSync({ apiKey, appVersion, gameDomains, entryByKey }) {
  for (const gameDomain of gameDomains) {
    logSection(`Full Refresh ${gameDomain}`);
    const discoveredMods = await discoverModsForGame(apiKey, appVersion, gameDomain);
    const existingModIds = getExistingModIdsForGame(entryByKey, gameDomain);
    const modIds = [...new Set([...existingModIds, ...discoveredMods.map((item) => item.mod_id)])].sort((a, b) => b - a);
    logInfo(`Candidate mods: ${modIds.length}`);

    for (const modId of modIds) {
      const entryKey = getEntryKey(gameDomain, modId);
      const existingEntry = entryByKey.get(entryKey);

      try {
        await refreshModAndNotify({
          apiKey,
          appVersion,
          gameDomain,
          modId,
          existingEntry,
          entryByKey,
        });
      } catch (error) {
        if (isUnavailableModError(error)) {
          if (existingEntry) {
            logWarn("UNAVAILABLE", `Mod ${modId} is no longer available; keeping existing entry.`);
          } else {
            logWarn("UNAVAILABLE", `Skipping unavailable mod ${modId}.`);
          }
          continue;
        }

        if (existingEntry) {
          logWarn("MOD_FAIL", `Failed to refresh mod ${modId}; keeping existing entry. ${error.message}`);
        } else {
          logWarn("MOD_FAIL", `Failed to refresh mod ${modId}; skipping new entry. ${error.message}`);
        }
      }
    }
  }
}

function getExistingModIdsForGame(entryByKey, gameDomain) {
  return [...entryByKey.values()]
    .filter((entry) => entry?.NexusGameDomain === gameDomain && Number.isInteger(entry?.NexusModId))
    .map((entry) => entry.NexusModId);
}

async function refreshModAndNotify({
  apiKey,
  appVersion,
  gameDomain,
  modId,
  modInfo,
  modFiles,
  existingEntry,
  entryByKey,
}) {
  logStep(`Refreshing mod ${modId}`);
  const resolvedModInfo = modInfo ?? await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}`, apiKey, appVersion);
  const resolvedModFiles = modFiles ?? await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files`, apiKey, appVersion);
  const selectedFile = selectBestFile(resolvedModFiles);
  if (!selectedFile) {
    throw new Error(`No downloadable file found for mod ${modId}.`);
  }

  logSubstep(`Selected file ${selectedFile.file_id}: ${selectedFile.file_name}`);
  const downloadsSinceLatestVersion = await getFileDownloadCount({
    apiKey,
    appVersion,
    fileInfo: selectedFile,
  });
  const dependencies = await getFileDependencies({
    apiKey,
    appVersion,
    gameDomain,
    fileInfo: selectedFile,
  });
  const archiveContext = await processArchive({
    apiKey,
    appVersion,
    gameDomain,
    modId,
    fileInfo: selectedFile,
  });

  const mergedEntry = mergeEntry({
    existingEntry,
    modInfo: resolvedModInfo,
    fileInfo: selectedFile,
    archiveContext,
    downloadsSinceLatestVersion,
    dependencies,
  });

  entryByKey.set(getEntryKey(gameDomain, modId), mergedEntry);
  logModChanges(existingEntry, mergedEntry, modId, resolvedModInfo.name);

  const notification = buildNotification(existingEntry, mergedEntry, archiveContext);
  if (notification) {
    await sendDiscordNotification(notification);
  }
}

async function refreshLatestFileDownloads({
  apiKey,
  appVersion,
  gameDomain,
  modId,
  modInfo,
  existingEntry,
  entryByKey,
}) {
  const modFiles = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files`, apiKey, appVersion);
  const selectedFile = selectBestFile(modFiles);
  if (!selectedFile) {
    logWarn("FILE_STATS", `No downloadable file found for mod ${modId}; keeping existing download count.`);
    return;
  }

  const selectedDownloadUrl = buildDownloadUrl(
    gameDomain,
    modId,
    selectedFile.file_id,
    existingEntry?.DownloadUrl,
  );
  if (!areEqual(existingEntry?.DownloadUrl, selectedDownloadUrl)) {
    logInfo(`Latest file changed for mod ${modId}; refreshing archive metadata.`);
    await refreshModAndNotify({
      apiKey,
      appVersion,
      gameDomain,
      modId,
      modInfo,
      modFiles,
      existingEntry,
      entryByKey,
    });
    return;
  }

  const downloadsSinceLatestVersion = await getFileDownloadCount({
    apiKey,
    appVersion,
    fileInfo: selectedFile,
  });
  const containsAdultContent = modInfo.contains_adult_content ?? existingEntry?.ContainsAdultContent ?? false;
  const downloadsChanged = downloadsSinceLatestVersion !== null
    && !areEqual(existingEntry?.downloadsSinceLatestVersion, downloadsSinceLatestVersion);
  const adultFlagChanged = !areEqual(existingEntry?.ContainsAdultContent, containsAdultContent);

  if (!downloadsChanged && !adultFlagChanged) {
    logDim(`   No Nexus version or latest-file download change for mod ${modId}.`);
    return;
  }

  entryByKey.set(getEntryKey(gameDomain, modId), {
    ...existingEntry,
    ...(downloadsChanged ? { downloadsSinceLatestVersion } : {}),
    ContainsAdultContent: containsAdultContent,
  });
  if (downloadsChanged) {
    logSuccess(
      `Updated mod ${modId} downloadsSinceLatestVersion: `
      + `${formatValue(existingEntry?.downloadsSinceLatestVersion)} -> ${formatValue(downloadsSinceLatestVersion)}`,
    );
  }
  if (adultFlagChanged) {
    logSuccess(
      `Updated mod ${modId} ContainsAdultContent: `
      + `${formatValue(existingEntry?.ContainsAdultContent)} -> ${formatValue(containsAdultContent)}`,
    );
  }
}

async function discoverRecentModsForGame(apiKey, appVersion, gameDomain) {
  const discovered = new Map();
  for (const routeSuffix of QUICK_DISCOVERY_ROUTES) {
    const route = `/games/${encodeURIComponent(gameDomain)}${routeSuffix}`;
    try {
      logSubstep(`Quick feed ${route}`);
      const response = await nexusRest(route, apiKey, appVersion);
      for (const item of normalizeDiscoveredMods(response)) {
        if (Number.isInteger(item.mod_id)) {
          discovered.set(item.mod_id, item);
        }
      }
    } catch (error) {
      logWarn("DISCOVERY", `Quick feed failed for ${route}. ${error.message}`);
    }
  }

  return [...discovered.values()].sort((left, right) => (right.mod_id ?? 0) - (left.mod_id ?? 0));
}

async function discoverModsForGame(apiKey, appVersion, gameDomain) {
  const discovered = new Map();
  const routes = [
    `/games/${encodeURIComponent(gameDomain)}/mods/latest_added`,
    `/games/${encodeURIComponent(gameDomain)}/mods/latest_updated`,
    `/games/${encodeURIComponent(gameDomain)}/mods/trending`,
    ...FULL_RECENT_PERIODS.map((period) => `/games/${encodeURIComponent(gameDomain)}/mods/updated?period=${period}`),
  ];

  for (const route of routes) {
    try {
      logSubstep(`Discovery feed ${route}`);
      const response = await nexusRest(route, apiKey, appVersion);
      const countBefore = discovered.size;
      for (const item of normalizeDiscoveredMods(response)) {
        if (Number.isInteger(item.mod_id)) {
          discovered.set(item.mod_id, item);
        }
      }
      logInfo(`Discovery feed added ${discovered.size - countBefore} mod(s).`);
    } catch (error) {
      logWarn("DISCOVERY", `Feed failed for ${route}. ${error.message}`);
    }
  }

  logInfo(`Discovery complete for ${gameDomain}: ${discovered.size} unique mod(s).`);
  return [...discovered.values()];
}

function normalizeDiscoveredMods(response) {
  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .map((item) => item?.mod ? item.mod : item)
    .filter((item) => Number.isInteger(item?.mod_id));
}

async function processArchive({ apiKey, appVersion, gameDomain, modId, fileInfo }) {
  const extension = path.extname(fileInfo.file_name || "").toLowerCase();
  if (!DOWNLOADABLE_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported archive type "${extension || "<none>"}" for file ${fileInfo.file_name}.`);
  }

  const workDir = await mkdtemp(path.join(TEMP_ROOT, `mod-${modId}-`));
  const archivePath = path.join(workDir, fileInfo.file_name);
  const extractDir = path.join(workDir, "extract");
  await mkdir(extractDir, { recursive: true });

  try {
    logSubstep(`Downloading archive ${fileInfo.file_name}`);
    const downloadLinks = await getDownloadLinks({
      apiKey,
      appVersion,
      gameDomain,
      modId,
      fileId: fileInfo.file_id,
    });
    const mirrorLinks = await downloadArchive({
      appVersion,
      downloadLinks,
      fileInfo,
      destinationPath: archivePath,
    });
    const archiveSizeBytes = (await stat(archivePath)).size;
    const sha256 = await calculateFileSha256(archivePath);
    logInfo(`SHA-256: ${sha256}`);

    logSubstep(`Extracting ${extension} archive`);
    await extractArchive(archivePath, extractDir, extension);

    const dllFiles = await listDllFiles(extractDir);
    const dllSizeBytes = (await Promise.all(dllFiles.map(async (dllFile) => (await stat(dllFile)).size)))
      .reduce((total, size) => total + size, 0);
    logInfo(`DLLs found: ${dllFiles.length}`);
    if (dllFiles.length > 0) {
      logDim(`   ${dllFiles.map((entry) => path.basename(entry)).join(", ")}`);
    }

    const dllVersions = {};
    const dllSHA256s = {};
    for (const dllFile of dllFiles) {
      const dllName = path.basename(dllFile);
      dllSHA256s[dllName] = await calculateFileSha256(dllFile);

      const parsed = await readDllMetadata(dllFile);
      if (parsed.bepinexVersion) {
        dllVersions[dllName] = parsed.bepinexVersion;
      } else {
        logDim(`   ${dllName}: no BepInEx plugin version found`);
      }
    }

    logInfo(`DLL SHA-256 hashes calculated: ${Object.keys(dllSHA256s).length}`);
    for (const [dllName, dllSHA256] of Object.entries(dllSHA256s)) {
      logDim(`   ${dllName}: ${dllSHA256}`);
    }

    logInfo(`BepInEx plugin versions found: ${Object.keys(dllVersions).length}`);
    if (Object.keys(dllVersions).length > 0) {
      for (const [dllName, version] of Object.entries(dllVersions)) {
        logDim(`   ${dllName}: ${version}`);
      }
    }

    return {
      dllNames: dllFiles.map((entry) => path.basename(entry)).sort((a, b) => a.localeCompare(b)),
      dllSHA256s,
      dllVersions,
      dllVersion: highestVersion(Object.values(dllVersions)),
      bepinexVersion: highestVersion(Object.values(dllVersions)),
      mirrorLinks,
      sha256,
      archiveSizeBytes,
      dllSizeBytes,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function downloadArchive({ appVersion, downloadLinks, fileInfo, destinationPath }) {
  if (!downloadLinks.length) {
    throw new Error(`No archive download URLs were returned for file ${fileInfo.file_id}.`);
  }

  const primaryUrl = normalizeDownloadUrl(downloadLinks[0]);
  if (!primaryUrl) {
    throw new Error(`Download response for file ${fileInfo.file_id} did not contain a valid URI.`);
  }

  const mirrorLinks = downloadLinks
    .map(normalizeDownloadUrl)
    .filter((value) => typeof value === "string" && value.length > 0);

  logSubstep(`Downloading from ${primaryUrl}`);

  const response = await fetchWithTimeout(primaryUrl, {
    headers: {
      "User-Agent": `${APP_NAME}/${appVersion}`,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw await buildHttpError("Archive download failed", response);
  }

  const fileStream = createWriteStream(destinationPath);
  await response.body.pipeTo(new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        fileStream.write(Buffer.from(chunk), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        fileStream.end((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    abort(reason) {
      fileStream.destroy(reason);
    },
  }));

  const downloaded = await stat(destinationPath);
  logInfo(`Downloaded ${(downloaded.size / 1024 / 1024).toFixed(2)} MB`);
  return mirrorLinks;
}

async function calculateFileSha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function extractArchive(archivePath, extractDir, extension) {
  if (extension === ".zip") {
    await extractZip(archivePath, extractDir);
    return;
  }

  if (extension === ".rar") {
    await extractRar(archivePath, extractDir);
    return;
  }

  if (extension === ".7z") {
    await extract7zArchive(archivePath, extractDir);
    return;
  }

  throw new Error(`Unsupported archive extension "${extension}".`);
}

async function extractZip(archivePath, extractDir) {
  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }

      zipFile.readEntry();
      zipFile.on("entry", async (entry) => {
        try {
          const destination = path.join(extractDir, entry.fileName);
          if (/\/$/.test(entry.fileName)) {
            await mkdir(destination, { recursive: true });
            zipFile.readEntry();
            return;
          }

          await mkdir(path.dirname(destination), { recursive: true });
          zipFile.openReadStream(entry, (streamError, readStream) => {
            if (streamError) {
              reject(streamError);
              return;
            }

            const writeStream = createWriteStream(destination);
            readStream.on("error", reject);
            writeStream.on("error", reject);
            writeStream.on("close", () => zipFile.readEntry());
            readStream.pipe(writeStream);
          });
        } catch (entryError) {
          reject(entryError);
        }
      });

      zipFile.on("end", resolve);
      zipFile.on("error", reject);
    });
  });
}

async function extractRar(archivePath, extractDir) {
  const extractor = await createExtractorFromFile({
    filepath: archivePath,
    targetPath: extractDir,
  });

  const result = extractor.extract({});
  const extractedFiles = [...result.files];
  if (extractedFiles.length === 0) {
    logWarn("RAR", `No files were extracted from ${path.basename(archivePath)}.`);
  }
}

async function extract7zArchive(archivePath, extractDir) {
  await new Promise((resolve, reject) => {
    const stream = extractFull(archivePath, extractDir, {
      $bin: sevenBin.path7za,
      recursive: true,
    });

    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

async function listDllFiles(rootDir) {
  const results = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(current, { withFileTypes: true }));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function readDllMetadata(dllPath) {
  const monoCecilDllPath = process.env.MONO_CECIL_DLL_PATH;
  if (!monoCecilDllPath) {
    throw new Error("Missing MONO_CECIL_DLL_PATH environment variable.");
  }

  const escapedPath = dllPath.replace(/'/g, "''");
  const escapedMonoCecilPath = (await getReadyMonoCecilPath(monoCecilDllPath)).replace(/'/g, "''");
  const script = [
    `$path = '${escapedPath}'`,
    `$monoCecilPath = '${escapedMonoCecilPath}'`,
    "$json = @{ bepinexVersion = $null }",
    "try {",
    "  Add-Type -Path $monoCecilPath",
    "  $module = [Mono.Cecil.ModuleDefinition]::ReadModule($path)",
    "  try {",
    "    foreach ($type in $module.Types) {",
    "      foreach ($attr in $type.CustomAttributes) {",
    "        if ($attr.AttributeType.FullName -eq 'BepInEx.BepInPlugin' -and $attr.ConstructorArguments.Count -ge 3) {",
    "          $value = [string]$attr.ConstructorArguments[2].Value",
    "          if (-not [string]::IsNullOrWhiteSpace($value)) {",
    "            $json.bepinexVersion = $value",
    "            break",
    "          }",
    "        }",
    "      }",
    "      if ($json.bepinexVersion) { break }",
    "    }",
    "  } finally {",
    "    $module.Dispose()",
    "  }",
    "} catch {",
    "  throw $_",
    "}",
    "$json | ConvertTo-Json -Compress",
  ].join("; ");

  const result = await execProcess(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-Command", script],
    REPO_ROOT,
    20_000,
  );
  const payload = JSON.parse(result.trim() || "{}");
  return {
    bepinexVersion: payload.bepinexVersion || null,
  };
}

async function getReadyMonoCecilPath(sourcePath) {
  if (cachedMonoCecilPath) {
    return cachedMonoCecilPath;
  }

  const sourceInfo = await stat(sourcePath);
  const stagedPath = path.join(TEMP_ROOT, `Mono.Cecil-${sourceInfo.mtimeMs}-${sourceInfo.size}.dll`);
  await mkdir(path.dirname(stagedPath), { recursive: true });
  await writeFile(stagedPath, await readFile(sourcePath));

  try {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", `Unblock-File -LiteralPath '${stagedPath.replace(/'/g, "''")}'`], (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } catch {
    // Some environments do not support zone metadata; the copy still works there.
  }

  cachedMonoCecilPath = stagedPath;
  return stagedPath;
}

async function getDownloadLinks({ apiKey, appVersion, gameDomain, modId, fileId }) {
  const route = `/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files/${fileId}/download_link.json`;
  return await nexusRest(route, apiKey, appVersion);
}

function normalizeDownloadUrl(entry) {
  if (typeof entry === "string") {
    return entry;
  }

  if (entry && typeof entry.URI === "string") {
    return entry.URI;
  }

  if (entry && typeof entry.uri === "string") {
    return entry.uri;
  }

  return null;
}

function mergeEntry({
  existingEntry,
  modInfo,
  fileInfo,
  archiveContext,
  downloadsSinceLatestVersion,
  dependencies,
}) {
  const preserved = { ...(existingEntry ?? {}) };
  for (const key of OWNED_FIELDS) {
    delete preserved[key];
  }

  const links = {
    ...(existingEntry?.Links ?? {}),
    Icon: modInfo.picture_url ?? existingEntry?.Links?.Icon ?? null,
    NexusMods: buildModUrl(modInfo.domain_name, modInfo.mod_id),
  };

  const previousDllNames = normalizeDllArray(existingEntry?.dllNames);
  const nextDllNames = archiveContext?.dllNames?.length ? archiveContext.dllNames : previousDllNames;
  const nextDllVersions = archiveContext && Object.keys(archiveContext.dllVersions || {}).length > 0
    ? archiveContext.dllVersions
    : (existingEntry?.dllVersions ?? {});
  const nextDllSHA256s = archiveContext?.dllSHA256s ?? existingEntry?.dllSHA256s ?? {};
  const nextDllVersion = archiveContext?.dllVersion ?? existingEntry?.dllVersion ?? highestVersion(Object.values(nextDllVersions));
  const nextBepinexVersion = archiveContext?.bepinexVersion ?? existingEntry?.bepinexVersion ?? highestVersion(Object.values(nextDllVersions));
  const lastUpdated = formatTimestamp(
    modInfo.updated_timestamp
    ?? fileInfo?.uploaded_timestamp
    ?? existingEntry?.LastUpdated,
  );
  const releaseDate = formatTimestamp(
    fileInfo?.uploaded_timestamp
    ?? modInfo.created_timestamp
    ?? modInfo.uploaded_timestamp
    ?? existingEntry?.ReleaseDate,
  );

  return {
    ...preserved,
    Id: `nexus-${modInfo.mod_id}`,
    Name: modInfo.name ?? existingEntry?.Name ?? `Mod ${modInfo.mod_id}`,
    Version: modInfo.version ?? existingEntry?.Version ?? "",
    bepinexVersion: nextBepinexVersion ?? null,
    Description: modInfo.description ?? existingEntry?.Description ?? "",
    Author: modInfo.author ?? existingEntry?.Author ?? "",
    Links: links,
    DownloadUrl: buildDownloadUrl(modInfo.domain_name, modInfo.mod_id, fileInfo?.file_id, existingEntry?.DownloadUrl),
    NexusGameDomain: modInfo.domain_name,
    NexusModId: modInfo.mod_id,
    SourceName: "Nexus",
    ContainsAdultContent: modInfo.contains_adult_content ?? existingEntry?.ContainsAdultContent ?? false,
    LastUpdated: lastUpdated,
    ReleaseDate: releaseDate,
    SHA256: archiveContext?.sha256 ?? existingEntry?.SHA256 ?? null,
    dllSHA256s: nextDllSHA256s,
    downloadsSinceLatestVersion: downloadsSinceLatestVersion
      ?? existingEntry?.downloadsSinceLatestVersion
      ?? null,
    Dependencies: dependencies ?? existingEntry?.Dependencies ?? [],
    dllNames: nextDllNames,
    dllVersion: nextDllVersion ?? null,
    dllVersions: nextDllVersions,
    Statistics: {
      Endorsements: modInfo.endorsement_count ?? existingEntry?.Statistics?.Endorsements ?? null,
      UniqueDownloads: modInfo.mod_unique_downloads ?? existingEntry?.Statistics?.UniqueDownloads ?? null,
      TotalDownloads: modInfo.mod_downloads ?? existingEntry?.Statistics?.TotalDownloads ?? null,
      TotalViews: existingEntry?.Statistics?.TotalViews ?? null,
    },
    Images: collectImages(modInfo, existingEntry?.Images),
  };
}

function collectImages(modInfo, fallbackImages) {
  const images = new Set();
  if (typeof modInfo.picture_url === "string" && modInfo.picture_url.length > 0) {
    images.add(modInfo.picture_url);
  }
  for (const value of Array.isArray(fallbackImages) ? fallbackImages : []) {
    if (typeof value === "string" && value.length > 0) {
      images.add(value);
    }
  }
  return [...images];
}

function selectBestFile(modFiles) {
  const files = Array.isArray(modFiles?.files) ? modFiles.files : [];
  return [...files]
    .filter((file) => DOWNLOADABLE_EXTENSIONS.has(path.extname(file.file_name || "").toLowerCase()))
    .sort((left, right) => scoreFile(right) - scoreFile(left))[0] ?? null;
}

function scoreFile(file) {
  const primary = file?.is_primary ? 1_000_000_000 : 0;
  const mainCategory = file?.category_name === "MAIN" ? 100_000_000 : 0;
  const uploaded = Number(file?.uploaded_timestamp) || 0;
  return primary + mainCategory + uploaded;
}

function buildModUrl(gameDomain, modId) {
  return `https://www.nexusmods.com/${gameDomain}/mods/${modId}`;
}

function buildDownloadUrl(gameDomain, modId, fileId, fallback) {
  if (Number.isInteger(fileId)) {
    return `nexus://${gameDomain}/${modId}/${fileId}`;
  }

  return fallback ?? `nexus://${gameDomain}/${modId}`;
}

function compareEntries(left, right) {
  const leftId = Number.isInteger(left?.NexusModId) ? left.NexusModId : Number.MIN_SAFE_INTEGER;
  const rightId = Number.isInteger(right?.NexusModId) ? right.NexusModId : Number.MIN_SAFE_INTEGER;
  return rightId - leftId;
}

function getEntryKey(gameDomain, modId) {
  return `${gameDomain}:${modId}`;
}

function normalizeDllArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }

    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  return null;
}

function highestVersion(versions) {
  const filtered = versions.filter((value) => typeof value === "string" && value.trim().length > 0);
  if (filtered.length === 0) {
    return null;
  }

  return [...filtered].sort(compareVersions).reverse()[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function normalizeVersion(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".").filter(Boolean);
  while (parts.length < 4) {
    parts.push("0");
  }
  return parts.slice(0, 4).join(".");
}

function isUnavailableModError(error) {
  const message = String(error?.message ?? "");
  return message.includes("403 Forbidden") && message.includes("Mod not available");
}

function buildNotification(previousEntry, nextEntry, archiveContext) {
  if (!nextEntry?.Links?.NexusMods) {
    return null;
  }

  if (previousEntry === undefined) {
    return {
      kind: "created",
      content: buildDiscordMessage(nextEntry),
      embed: createDiscordEmbed({
        type: "created",
        currentEntry: nextEntry,
        archiveSizeBytes: archiveContext?.archiveSizeBytes,
        dllSizeBytes: archiveContext?.dllSizeBytes,
      }),
    };
  }

  if (!areEqual(previousEntry?.Version, nextEntry?.Version)) {
    return {
      kind: "updated",
      content: buildDiscordMessage(nextEntry),
      embed: createDiscordEmbed({
        type: "updated",
        previousEntry,
        currentEntry: nextEntry,
      }),
    };
  }

  return null;
}

function createDiscordEmbed({ type, previousEntry, currentEntry, archiveSizeBytes, dllSizeBytes }) {
  const modUrl = currentEntry.Links?.NexusMods;
  const imageUrl = firstNonEmptyString(
    currentEntry.Links?.Icon,
    Array.isArray(currentEntry.Images) ? currentEntry.Images[0] : null,
  );
  let fields;
  if (type === "created") {
    fields = [
      {
        name: "File Size",
        value: formatFileSize(dllSizeBytes),
        inline: true,
      },
      {
        name: "Zip Size",
        value: formatFileSize(archiveSizeBytes),
        inline: true,
      },
    ];
  } else {
    fields = [
      {
        name: "Endorsements",
        value: formatInlineStat(currentEntry.Statistics?.Endorsements),
        inline: true,
      },
      {
        name: "Unique Downloads",
        value: formatInlineStat(currentEntry.Statistics?.UniqueDownloads),
        inline: true,
      },
    ];
  }

  if (type === "updated") {
    fields.unshift({
      name: "Nexus Version",
      value: `${formatInlineText(previousEntry?.Version)} -> ${formatInlineText(currentEntry.Version)}`,
      inline: true,
    });

    if (currentEntry.bepinexVersion) {
      fields.push({
        name: "BepInEx Version",
        value: String(currentEntry.bepinexVersion),
        inline: true,
      });
    }
  }

  return {
    title: currentEntry.Name ?? `Mod ${currentEntry.NexusModId}`,
    url: modUrl,
    description: type === "created" ? "New NexusMods release detected." : "NexusMods version update detected.",
    color: type === "created" ? DISCORD_COLORS.created : DISCORD_COLORS.updated,
    author: currentEntry.Author
      ? {
          name: currentEntry.Author,
          url: modUrl,
        }
      : undefined,
    fields,
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: {
      text: `Nexus mod ${currentEntry.NexusModId}`,
    },
    timestamp: new Date().toISOString(),
  };
}

async function sendDiscordNotification(notification) {
  const webhookUrl = notification.kind === "created"
    ? process.env.DISCORD_WEBHOOK_URL_RELEASES
    : process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    logWarn("DISCORD", `Missing webhook for ${notification.kind}; skipping Discord notification.`);
    return;
  }

  await postDiscordWebhook(webhookUrl, {
    username: DISCORD_USERNAME,
    avatar_url: DISCORD_AVATAR_URL,
    content: notification.content,
    embeds: [notification.embed],
  });

  logSuccess(`Sent ${notification.kind} Discord notification.`);
}

function buildDiscordMessage(entry) {
  return entry?.ContainsAdultContent === true ? ADULT_MOD_MESSAGE : "";
}

async function postDiscordWebhook(webhookUrl, payload) {
  const response = await fetchWithTimeout(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await buildHttpError("Discord webhook request failed", response);
  }
}

function logModChanges(previousEntry, nextEntry, modId, modName) {
  const label = `mod ${modId}${modName ? ` (${modName})` : ""}`;
  const changedFields = [];
  const unchangedFields = [];

  for (const field of TRACKED_LOG_FIELDS) {
    const before = getFieldValue(previousEntry, field);
    const after = getFieldValue(nextEntry, field);
    if (areEqual(before, after)) {
      unchangedFields.push(`${field}: ${formatValue(after)}`);
    } else {
      changedFields.push(`${field}: ${formatValue(before)} -> ${formatValue(after)}`);
    }
  }

  if (previousEntry === undefined) {
    logSuccess(`Created ${label}.`);
  } else if (changedFields.length === 0) {
    logInfo(`No tracked field changes for ${label}.`);
  } else {
    logSuccess(`Updated ${label}.`);
  }

  for (const field of changedFields) {
    console.log(colorize(COLORS.green, `   + ${field}`));
  }
  for (const field of unchangedFields) {
    console.log(colorize(COLORS.dim, `   = ${field}`));
  }
}

function getFieldValue(entry, field) {
  if (!entry) {
    return undefined;
  }

  return field.split(".").reduce((current, part) => current?.[part], entry);
}

function areEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatValue(value) {
  if (value === undefined) {
    return "<undefined>";
  }

  if (value === null) {
    return "<null>";
  }

  if (typeof value === "string") {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return JSON.stringify(collapsed.length > MAX_MOD_LOG_DESCRIPTION ? `${collapsed.slice(0, MAX_MOD_LOG_DESCRIPTION - 3)}...` : collapsed);
  }

  return JSON.stringify(value);
}

function formatInlineStat(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US");
  }
  return "Unknown";
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "Unknown";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : size < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatInlineText(value) {
  if (value === undefined || value === null) {
    return "Unknown";
  }

  const text = String(value).trim();
  return text.length > 0 ? text : "Unknown";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

async function validateApiKey(apiKey, appVersion) {
  await nexusRest("/users/validate", apiKey, appVersion);
}

async function getFileDownloadCount({ apiKey, appVersion, fileInfo }) {
  if (fileInfo?.uid === undefined || fileInfo?.uid === null) {
    logWarn("FILE_STATS", `File ${fileInfo?.file_id ?? "<unknown>"} has no UID; download count is unavailable.`);
    return null;
  }

  try {
    const data = await nexusGraphQL(
      `query FileDownloadCount($uids: [ID!]!) {
        modFilesByUid(uids: $uids) {
          nodes {
            uid
            count
            totalDownloads
          }
        }
      }`,
      { uids: [String(fileInfo.uid)] },
      apiKey,
      appVersion,
    );
    const file = data?.modFilesByUid?.nodes?.find(
      (candidate) => String(candidate?.uid) === String(fileInfo.uid),
    );
    const downloads = file?.totalDownloads ?? file?.count;
    if (typeof downloads === "number" && Number.isFinite(downloads)) {
      logInfo(`Downloads for latest file: ${downloads}`);
      return downloads;
    }
  } catch (error) {
    logWarn("FILE_STATS", `Could not load download count for file ${fileInfo.file_id}. ${error.message}`);
    return null;
  }

  logWarn("FILE_STATS", `No download count was returned for file ${fileInfo.file_id}.`);
  return null;
}

async function getFileDependencies({ apiKey, appVersion, gameDomain, fileInfo }) {
  if (!Number.isInteger(fileInfo?.file_id)) {
    logWarn("DEPENDENCIES", "Selected file has no file ID; dependencies are unavailable.");
    return null;
  }

  try {
    const version = await nexusV3(`/games/${encodeURIComponent(gameDomain)}/mod-file-versions/${fileInfo.file_id}`, apiKey, appVersion);
    const versionId = version?.id;
    if (!versionId) {
      logWarn("DEPENDENCIES", `No v3 version ID was returned for file ${fileInfo.file_id}.`);
      return null;
    }

    const response = await nexusV3(`/mod-file-versions/${encodeURIComponent(versionId)}/dependencies`, apiKey, appVersion);
    const dependencies = extractDependencyIds(response);
    logInfo(`Declared mod dependencies: ${dependencies.length}`);
    if (dependencies.length > 0) {
      logDim(`   ${dependencies.join(", ")}`);
    }
    return dependencies;
  } catch (error) {
    logWarn("DEPENDENCIES", `Could not load dependencies for file ${fileInfo.file_id}. ${error.message}`);
    return null;
  }
}

function extractDependencyIds(response) {
  const ids = new Set();
  for (const definition of response?.dependency_definitions ?? []) {
    for (const range of definition?.ranges ?? []) {
      const modId = range?.target_mod_file?.mod?.game_scoped_id;
      if (/^\d+$/.test(String(modId))) {
        ids.add(`nexus-${modId}`);
      }
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function runSelfTest() {
  const createdNotification = buildNotification(undefined, {
    Name: "Test Mod",
    NexusModId: 1,
    Links: { NexusMods: "https://www.nexusmods.com/scavprototype/mods/1" },
    Statistics: { Endorsements: 0, UniqueDownloads: 3 },
  }, { archiveSizeBytes: 3_145_728, dllSizeBytes: 1_572_864 });
  if (!areEqual(createdNotification?.embed?.fields, [
    { name: "File Size", value: "1.5 MB", inline: true },
    { name: "Zip Size", value: "3.0 MB", inline: true },
  ])) {
    throw new Error("New-mod Discord file-size self-test failed.");
  }
  if (buildDiscordMessage({ ContainsAdultContent: true }) !== ADULT_MOD_MESSAGE || buildDiscordMessage({ ContainsAdultContent: false }) !== "") {
    throw new Error("Adult-mod Discord message self-test failed.");
  }

  const dependencies = extractDependencyIds({
    dependency_definitions: [
      { ranges: [{ target_mod_file: { mod: { game_scoped_id: "341" } } }] },
      { ranges: [{ target_mod_file: { mod: { game_scoped_id: "67" } } }, { target_mod_file: { mod: { game_scoped_id: "341" } } }] },
    ],
  });
  if (!areEqual(dependencies, ["nexus-67", "nexus-341"])) {
    throw new Error("Dependency extraction self-test failed.");
  }

  const badges = buildNexusBadges([
    {
      NexusGameDomain: "scavprototype",
      NexusModId: 341,
      Name: "CUCoreLib",
      Statistics: { TotalDownloads: 1234 },
    },
    {
      NexusGameDomain: "scavprototype",
      NexusModId: 7,
      Name: "QoL Unknown",
      Statistics: {},
    },
    {
      NexusGameDomain: "scavprototype",
      NexusModId: 1,
      Name: "Item Spawner Menu",
      Statistics: { TotalDownloads: 5 },
    },
    {
      NexusGameDomain: "scavprototype",
      NexusModId: 90,
      Name: "Item Spawner Menu.",
      Statistics: { TotalDownloads: 10 },
    },
  ]);
  if (!areEqual(badges, [
    { modId: 341, name: "CUCoreLib", downloads: 1234, baseName: "cucorelib", fileName: "cucorelib.json" },
    { modId: 1, name: "Item Spawner Menu", downloads: 5, baseName: "item-spawner-menu", fileName: "item-spawner-menu-1.json" },
    { modId: 90, name: "Item Spawner Menu.", downloads: 10, baseName: "item-spawner-menu", fileName: "item-spawner-menu-90.json" },
    { modId: 7, name: "QoL Unknown", downloads: null, baseName: "qol-unknown", fileName: "qol-unknown.json" },
  ])) {
    throw new Error("Nexus badge export self-test failed.");
  }
  logSuccess("Dependency extraction self-test passed.");
  logSuccess("Nexus badge export self-test passed.");
  logSuccess("New-mod Discord file-size self-test passed.");
  logSuccess("Adult-mod Discord message self-test passed.");
}

async function nexusRest(route, apiKey, appVersion) {
  const response = await fetchWithTimeout(`${API_BASE_URL}${route}`, {
    headers: buildHeaders(apiKey, appVersion),
  });

  if (!response.ok) {
    throw await buildHttpError("Nexus REST request failed", response);
  }

  return response.json();
}

async function nexusV3(route, apiKey, appVersion) {
  const response = await fetchWithTimeout(`${V3_API_BASE_URL}${route}`, {
    headers: buildHeaders(apiKey, appVersion),
  });

  if (!response.ok) {
    throw await buildHttpError("Nexus v3 request failed", response);
  }

  const payload = await response.json();
  return payload?.data ?? payload;
}

async function nexusGraphQL(query, variables, apiKey, appVersion) {
  const response = await fetchWithTimeout(GRAPHQL_API_URL, {
    method: "POST",
    headers: buildHeaders(apiKey, appVersion),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw await buildHttpError("Nexus GraphQL request failed", response);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const messages = payload.errors
      .map((error) => error?.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Nexus GraphQL request failed: ${messages || "Unknown error"}`);
  }

  return payload?.data;
}

function buildHeaders(apiKey, appVersion) {
  return {
    "Content-Type": "application/json",
    "Protocol-Version": appVersion,
    "Application-Name": APP_NAME,
    "Application-Version": appVersion,
    "User-Agent": `${APP_NAME}/${appVersion}`,
    APIKEY: apiKey,
  };
}

async function buildHttpError(prefix, response) {
  const text = await response.text();
  return new Error(`${prefix} (${response.status} ${response.statusText}): ${text}`);
}

function colorize(color, text) {
  return `${color}${text}${COLORS.reset}`;
}

function logBanner(message) {
  console.log(colorize(COLORS.white, `\n==== ${message} ====\n`));
}

function logSection(message) {
  console.log(`\n${colorize(COLORS.magenta, `== ${message} ==`)}`);
}

function logStep(message) {
  console.log(colorize(COLORS.cyan, `-> ${message}`));
}

function logSubstep(message) {
  console.log(colorize(COLORS.blue, `   > ${message}`));
}

function logInfo(message) {
  console.log(colorize(COLORS.blue, message));
}

function logSuccess(message) {
  console.log(colorize(COLORS.green, message));
}

function logDim(message) {
  console.log(colorize(COLORS.dim, message));
}

function logWarn(code, message) {
  console.warn(colorize(COLORS.yellow, `Warning [${code}]: ${message}`));
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function execProcess(command, args, workdir, timeoutMs) {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile(command, args, { cwd: workdir, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else if (process.argv.includes("--export-badges")) {
  await exportNexusBadges().catch((error) => {
    console.error(colorize(COLORS.red, error.message));
    process.exitCode = 1;
  });
} else {
  await main().catch((error) => {
    console.error(colorize(COLORS.red, error.message));
    process.exitCode = 1;
  });
}
