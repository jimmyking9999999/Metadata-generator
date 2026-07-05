import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
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
const PACKAGE_PATH = path.join(REPO_ROOT, "package.json");
const TEMP_ROOT = path.join(os.tmpdir(), "metadata-nexusmods");

const API_BASE_URL = "https://api.nexusmods.com/v1";
const APP_NAME = "Metadata Nexus Sync";
const REQUEST_TIMEOUT_MS = 60_000;
const FULL_DISCOVERY_LIMIT = 64;
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
  const currentJson = await readFile(NEXUSMODS_PATH, "utf8");

  if (nextJson === currentJson) {
    logInfo("nexusmods.json is already up to date.");
    return;
  }

  await writeFile(NEXUSMODS_PATH, nextJson, "utf8");
  logSuccess("Updated nexusmods.json");
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
          logDim(`   No Nexus version change for mod ${modId}.`);
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
  existingEntry,
  entryByKey,
}) {
  logStep(`Refreshing mod ${modId}`);
  const resolvedModInfo = modInfo ?? await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}`, apiKey, appVersion);
  const modFiles = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files`, apiKey, appVersion);
  const selectedFile = selectBestFile(modFiles);
  if (!selectedFile) {
    throw new Error(`No downloadable file found for mod ${modId}.`);
  }

  logSubstep(`Selected file ${selectedFile.file_id}: ${selectedFile.file_name}`);
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
  });

  entryByKey.set(getEntryKey(gameDomain, modId), mergedEntry);
  logModChanges(existingEntry, mergedEntry, modId, resolvedModInfo.name);

  const notification = buildNotification(existingEntry, mergedEntry);
  if (notification) {
    await sendDiscordNotification(notification);
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
  return [...discovered.values()].slice(0, FULL_DISCOVERY_LIMIT * 4);
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

    logSubstep(`Extracting ${extension} archive`);
    await extractArchive(archivePath, extractDir, extension);

    const dllFiles = await listDllFiles(extractDir);
    logInfo(`DLLs found: ${dllFiles.length}`);
    if (dllFiles.length > 0) {
      logDim(`   ${dllFiles.map((entry) => path.basename(entry)).join(", ")}`);
    }

    const dllVersions = {};
    for (const dllFile of dllFiles) {
      const parsed = await readDllMetadata(dllFile);
      if (parsed.bepinexVersion) {
        dllVersions[path.basename(dllFile)] = parsed.bepinexVersion;
      } else {
        logDim(`   ${path.basename(dllFile)}: no BepInEx plugin version found`);
      }
    }

    logInfo(`BepInEx plugin versions found: ${Object.keys(dllVersions).length}`);
    if (Object.keys(dllVersions).length > 0) {
      for (const [dllName, version] of Object.entries(dllVersions)) {
        logDim(`   ${dllName}: ${version}`);
      }
    }

    return {
      dllNames: dllFiles.map((entry) => path.basename(entry)).sort((a, b) => a.localeCompare(b)),
      dllVersions,
      dllVersion: highestVersion(Object.values(dllVersions)),
      bepinexVersion: highestVersion(Object.values(dllVersions)),
      mirrorLinks,
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

function mergeEntry({ existingEntry, modInfo, fileInfo, archiveContext }) {
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
  const nextDllVersion = archiveContext?.dllVersion ?? existingEntry?.dllVersion ?? highestVersion(Object.values(nextDllVersions));
  const nextBepinexVersion = archiveContext?.bepinexVersion ?? existingEntry?.bepinexVersion ?? highestVersion(Object.values(nextDllVersions));

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

function buildNotification(previousEntry, nextEntry) {
  if (!nextEntry?.Links?.NexusMods) {
    return null;
  }

  if (previousEntry === undefined) {
    return {
      kind: "created",
      embed: createDiscordEmbed({
        type: "created",
        currentEntry: nextEntry,
      }),
    };
  }

  if (!areEqual(previousEntry?.Version, nextEntry?.Version)) {
    return {
      kind: "updated",
      embed: createDiscordEmbed({
        type: "updated",
        previousEntry,
        currentEntry: nextEntry,
      }),
    };
  }

  return null;
}

function createDiscordEmbed({ type, previousEntry, currentEntry }) {
  const modUrl = currentEntry.Links?.NexusMods;
  const imageUrl = firstNonEmptyString(
    currentEntry.Links?.Icon,
    Array.isArray(currentEntry.Images) ? currentEntry.Images[0] : null,
  );
  const endorsements = currentEntry.Statistics?.Endorsements;
  const uniqueDownloads = currentEntry.Statistics?.UniqueDownloads;
  const fields = [
    {
      name: "Endorsements",
      value: formatInlineStat(endorsements),
      inline: true,
    },
    {
      name: "Unique Downloads",
      value: formatInlineStat(uniqueDownloads),
      inline: true,
    },
  ];

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
    content: buildDiscordMessage(notification.kind),
    embeds: [notification.embed],
  });

  logSuccess(`Sent ${notification.kind} Discord notification.`);
}

function buildDiscordMessage(kind) {
  return kind === "created"
    ? ""
    : "";
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

async function nexusRest(route, apiKey, appVersion) {
  const response = await fetchWithTimeout(`${API_BASE_URL}${route}`, {
    headers: buildHeaders(apiKey, appVersion),
  });

  if (!response.ok) {
    throw await buildHttpError("Nexus REST request failed", response);
  }

  return response.json();
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

await main().catch((error) => {
  console.error(colorize(COLORS.red, error.message));
  process.exitCode = 1;
});
