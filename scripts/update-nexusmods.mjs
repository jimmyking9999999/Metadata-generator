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
const REPO_ROOT = path.resolve(__dirname, "..");
const NEXUSMODS_PATH = path.join(REPO_ROOT, "nexusmods.json");
const PACKAGE_PATH = path.join(REPO_ROOT, "package.json");
const TEMP_ROOT = path.join(os.tmpdir(), "metadata-nexusmods");

const API_BASE_URL = "https://api.nexusmods.com/v1";
const APP_NAME = "Metadata Nexus Sync";
const REQUEST_TIMEOUT_MS = 60_000;
const DISCOVERY_LIMIT = 64;
const RECENT_PERIODS = ["1d", "1w", "1m"];
const MAX_MOD_LOG_DESCRIPTION = 120;
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
const OWNED_FIELDS = new Set([
  "Id",
  "Name",
  "Version",
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
  "MirrorLinks",
  "Changelog",
  "Images",
]);
const TRACKED_LOG_FIELDS = [
  "Id",
  "Name",
  "Version",
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
  "MirrorLinks",
  "Changelog",
  "Images",
];
const DOWNLOADABLE_EXTENSIONS = new Set([".zip", ".7z", ".rar"]);

async function main() {
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NEXUS_API_KEY environment variable.");
  }

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

  logBanner("Nexus Mods Archive Sync");
  logInfo(`Loaded ${entries.length} existing entries.`);
  logInfo(`Refreshing game domains: ${gameDomains.join(", ")}`);

  await validateApiKey(apiKey, appVersion);
  logSuccess("Nexus API key validated.");

  const mergedEntries = [];
  const entryByKey = new Map();
  for (const entry of entries) {
    if (Number.isInteger(entry?.NexusModId) && entry?.NexusGameDomain) {
      entryByKey.set(getEntryKey(entry.NexusGameDomain, entry.NexusModId), entry);
    } else {
      mergedEntries.push(entry);
    }
  }

  for (const gameDomain of gameDomains) {
    logSection(`Refreshing ${gameDomain}`);

    const discoveredMods = await discoverModsForGame(apiKey, appVersion, gameDomain);
    const modIds = [...new Set([
      ...entries
        .filter((entry) => entry?.NexusGameDomain === gameDomain && Number.isInteger(entry?.NexusModId))
        .map((entry) => entry.NexusModId),
      ...discoveredMods.map((mod) => mod.mod_id),
    ])].sort((a, b) => b - a);

    logInfo(`Candidate mods: ${modIds.length}`);

    for (const modId of modIds) {
      const entryKey = getEntryKey(gameDomain, modId);
      const existingEntry = entryByKey.get(entryKey);

      try {
        logStep(`Refreshing mod ${modId}`);
        const modInfo = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}`, apiKey, appVersion);
        const modFiles = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files`, apiKey, appVersion);
        const changelogMap = await safeRequest(
          `changelogs for mod ${modId}`,
          () => nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/changelogs`, apiKey, appVersion),
        );

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
          modInfo,
          fileInfo: selectedFile,
          archiveContext,
          changelogMap,
        });

        mergedEntries.push(mergedEntry);
        logModChanges(existingEntry, mergedEntry, modId, modInfo.name);
      } catch (error) {
        if (isUnavailableModError(error)) {
          if (existingEntry) {
            logWarn("UNAVAILABLE", `Mod ${modId} is no longer available; keeping existing entry.`);
            mergedEntries.push(existingEntry);
          } else {
            logWarn("UNAVAILABLE", `Skipping unavailable mod ${modId}.`);
          }
          continue;
        }

        if (existingEntry) {
          logWarn("MOD_FAIL", `Failed to refresh mod ${modId}; keeping existing entry. ${error.message}`);
          mergedEntries.push(existingEntry);
          continue;
        }

        logWarn("MOD_FAIL", `Failed to refresh mod ${modId}; skipping new entry. ${error.message}`);
      }
    }
  }

  const sortedEntries = mergedEntries.sort(compareEntries);
  const nextJson = `${JSON.stringify(sortedEntries, null, 4)}\n`;
  const currentJson = await readFile(NEXUSMODS_PATH, "utf8");

  if (nextJson === currentJson) {
    logInfo("nexusmods.json is already up to date.");
    return;
  }

  await writeFile(NEXUSMODS_PATH, nextJson, "utf8");
  logSuccess("Updated nexusmods.json");
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
      if (parsed.version) {
        dllVersions[path.basename(dllFile)] = parsed.version;
      } else {
        logWarn("DLL_PARSE", `No usable version metadata found for ${path.basename(dllFile)}.`);
      }
    }

    logInfo(`DLL versions found: ${Object.keys(dllVersions).length}`);
    if (Object.keys(dllVersions).length > 0) {
      for (const [dllName, version] of Object.entries(dllVersions)) {
        logDim(`   ${dllName}: ${version}`);
      }
    }

    return {
      dllNames: dllFiles.map((entry) => path.basename(entry)).sort((a, b) => a.localeCompare(b)),
      dllVersions,
      dllVersion: highestVersion(Object.values(dllVersions)),
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
  const escapedPath = dllPath.replace(/'/g, "''");
  const script = [
    `$path = '${escapedPath}'`,
    "$json = @{ version = $null }",
    "try {",
    "  $asmName = [System.Reflection.AssemblyName]::GetAssemblyName($path)",
    "  $assemblyVersion = $asmName.Version.ToString()",
    "} catch {",
    "  $assemblyVersion = $null",
    "}",
    "$fileVersion = $null",
    "$productVersion = $null",
    "try {",
    "  $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)",
    "  $fileVersion = $info.FileVersion",
    "  $productVersion = $info.ProductVersion",
    "} catch {}",
    "$pluginVersion = $null",
    "try {",
    "  $asm = [System.Reflection.Assembly]::ReflectionOnlyLoadFrom($path)",
    "  foreach ($attr in $asm.CustomAttributes) {",
    "    if ($attr.AttributeType.FullName -eq 'BepInEx.BepInPlugin') {",
    "      if ($attr.ConstructorArguments.Count -ge 3) {",
    "        $pluginVersion = [string]$attr.ConstructorArguments[2].Value",
    "      }",
    "    }",
    "  }",
    "} catch {}",
    "function Normalize-Version([string]$value) {",
    "  $clean = ($value -replace '[^0-9\\.]', '')",
    "  if ([string]::IsNullOrWhiteSpace($clean)) { return '0.0.0.0' }",
    "  $parts = $clean.Split('.') | Where-Object { $_ -ne '' }",
    "  while ($parts.Count -lt 4) { $parts += '0' }",
    "  return ($parts[0..3] -join '.')",
    "}",
    "$candidates = @($pluginVersion, $productVersion, $fileVersion, $assemblyVersion) | Where-Object { $_ -and $_.Trim().Length -gt 0 }",
    "$json.version = if ($candidates.Count -gt 0) { $candidates | Sort-Object { [version](Normalize-Version $_) } -Descending | Select-Object -First 1 } else { $null }",
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
    version: payload.version || null,
  };
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

function mergeEntry({ existingEntry, modInfo, fileInfo, archiveContext, changelogMap }) {
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

  return {
    ...preserved,
    Id: `nexus-${modInfo.mod_id}`,
    Name: modInfo.name ?? existingEntry?.Name ?? `Mod ${modInfo.mod_id}`,
    Version: modInfo.version ?? existingEntry?.Version ?? "",
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
    MirrorLinks: archiveContext?.mirrorLinks?.length ? archiveContext.mirrorLinks : (existingEntry?.MirrorLinks ?? []),
    Changelog: latestChangelog(changelogMap) ?? existingEntry?.Changelog ?? null,
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

function latestChangelog(changelogMap) {
  if (!changelogMap || typeof changelogMap !== "object") {
    return null;
  }

  const entries = Object.entries(changelogMap).filter(([, value]) => typeof value === "string" && value.trim().length > 0);
  if (entries.length === 0) {
    return null;
  }

  entries.sort((left, right) => compareVersions(right[0], left[0]));
  return entries[0][1];
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

async function safeRequest(label, callback) {
  try {
    return await callback();
  } catch (error) {
    logWarn("BEST_EFFORT", `Failed to fetch ${label}. ${error.message}`);
    return null;
  }
}

async function discoverModsForGame(apiKey, appVersion, gameDomain) {
  const discovered = new Map();
  const feeds = [
    `/games/${encodeURIComponent(gameDomain)}/mods/latest_added`,
    `/games/${encodeURIComponent(gameDomain)}/mods/latest_updated`,
    `/games/${encodeURIComponent(gameDomain)}/mods/trending`,
    ...RECENT_PERIODS.map((period) => `/games/${encodeURIComponent(gameDomain)}/mods/updated?period=${period}`),
  ];

  for (const route of feeds) {
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
  return [...discovered.values()].slice(0, DISCOVERY_LIMIT * 4);
}

function normalizeDiscoveredMods(response) {
  if (!Array.isArray(response)) {
    return [];
  }

  return response
    .map((item) => item?.mod ? item.mod : item)
    .filter((item) => Number.isInteger(item?.mod_id));
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

function normalizeDllArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compareEntries(left, right) {
  const leftId = Number.isInteger(left?.NexusModId) ? left.NexusModId : Number.MIN_SAFE_INTEGER;
  const rightId = Number.isInteger(right?.NexusModId) ? right.NexusModId : Number.MIN_SAFE_INTEGER;
  return rightId - leftId;
}

function getEntryKey(gameDomain, modId) {
  return `${gameDomain}:${modId}`;
}

function isUnavailableModError(error) {
  const message = String(error?.message ?? "");
  return message.includes("403 Forbidden") && message.includes("Mod not available");
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
