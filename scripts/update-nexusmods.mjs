import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const NEXUSMODS_PATH = path.join(REPO_ROOT, "nexusmods.json");
const PACKAGE_PATH = path.join(REPO_ROOT, "package.json");

const API_BASE_URL = "https://api.nexusmods.com/v1";
const GRAPHQL_URL = "https://api.nexusmods.com/v2/graphql";
const APP_NAME = "Metadata Nexus Sync";
const REQUEST_TIMEOUT_MS = 30_000;
const DISCOVERY_LIMIT = 64;
const RECENT_PERIODS = ["1d", "1w", "1m"];
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
]);

async function main() {
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NEXUS_API_KEY environment variable.");
  }

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

  await validateApiKey(apiKey, appVersion);

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
    console.log(`Refreshing Nexus metadata for ${gameDomain}...`);

    const discoveredMods = await discoverModsForGame(apiKey, appVersion, gameDomain);
    const modIds = [...new Set([
      ...entries
        .filter((entry) => entry?.NexusGameDomain === gameDomain && Number.isInteger(entry?.NexusModId))
        .map((entry) => entry.NexusModId),
      ...discoveredMods.map((mod) => mod.mod_id),
    ])].sort((a, b) => b - a);

    console.log(`Found ${modIds.length} candidate mods for ${gameDomain}.`);

    for (const modId of modIds) {
      const entryKey = getEntryKey(gameDomain, modId);
      try {
        const modInfo = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}`, apiKey, appVersion);
        const modFiles = await nexusRest(`/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files`, apiKey, appVersion);
        const existingEntry = entryByKey.get(entryKey);
        const fileInfo = selectBestFile(modFiles);
        const detectedDlls = await detectDllNames({
          apiKey,
          appVersion,
          modId,
        });

        mergedEntries.push(mergeEntry(existingEntry, modInfo, fileInfo, detectedDlls));
      } catch (error) {
        const existingEntry = entryByKey.get(entryKey);
        if (existingEntry) {
          console.warn(`Warning: failed to refresh mod ${modId}; keeping existing entry. ${error.message}`);
          mergedEntries.push(existingEntry);
          continue;
        }

        throw error;
      }
    }
  }

  const sortedEntries = mergedEntries.sort(compareEntries);
  const nextJson = `${JSON.stringify(sortedEntries, null, 4)}\n`;
  const currentJson = await readFile(NEXUSMODS_PATH, "utf8");

  if (nextJson === currentJson) {
    console.log("nexusmods.json is already up to date.");
    return;
  }

  await writeFile(NEXUSMODS_PATH, nextJson, "utf8");
  console.log("Updated nexusmods.json");
}

function compareEntries(left, right) {
  const leftId = Number.isInteger(left?.NexusModId) ? left.NexusModId : Number.MIN_SAFE_INTEGER;
  const rightId = Number.isInteger(right?.NexusModId) ? right.NexusModId : Number.MIN_SAFE_INTEGER;
  return rightId - leftId;
}

function getEntryKey(gameDomain, modId) {
  return `${gameDomain}:${modId}`;
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
      const response = await nexusRest(route, apiKey, appVersion);
      for (const item of normalizeDiscoveredMods(response)) {
        if (Number.isInteger(item.mod_id)) {
          discovered.set(item.mod_id, item);
        }
      }
    } catch (error) {
      console.warn(`Warning: discovery feed failed for ${route}. ${error.message}`);
    }
  }

  const latestAdded = await nexusRest(
    `/games/${encodeURIComponent(gameDomain)}/mods/latest_added`,
    apiKey,
    appVersion,
  );
  for (const item of normalizeDiscoveredMods(latestAdded).slice(0, DISCOVERY_LIMIT)) {
    discovered.set(item.mod_id, item);
  }

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

function selectBestFile(modFiles) {
  const files = Array.isArray(modFiles?.files) ? modFiles.files : [];
  if (files.length === 0) {
    return null;
  }

  return [...files].sort((left, right) => scoreFile(right) - scoreFile(left))[0];
}

function scoreFile(file) {
  const primary = file?.is_primary ? 1_000_000_000 : 0;
  const mainCategory = file?.category_name === "MAIN" ? 100_000_000 : 0;
  const uploaded = Number(file?.uploaded_timestamp) || 0;
  return primary + mainCategory + uploaded;
}

function mergeEntry(existingEntry, modInfo, fileInfo, detectedDlls) {
  const preserved = { ...(existingEntry ?? {}) };
  for (const key of OWNED_FIELDS) {
    delete preserved[key];
  }

  const links = {
    ...(existingEntry?.Links ?? {}),
    Icon: modInfo.picture_url ?? existingEntry?.Links?.Icon ?? null,
    NexusMods: buildModUrl(modInfo.domain_name, modInfo.mod_id),
  };

  const dllNames = mergeDllNames(existingEntry?.dllNames, detectedDlls);

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
    dllNames,
  };
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

function mergeDllNames(existingDllNames, detectedDlls) {
  const merged = new Map();

  for (const dllName of normalizeDllArray(existingDllNames)) {
    merged.set(dllName.toLowerCase(), dllName);
  }

  for (const dllName of normalizeDllArray(detectedDlls)) {
    if (!merged.has(dllName.toLowerCase())) {
      merged.set(dllName.toLowerCase(), dllName);
    }
  }

  return [...merged.values()].sort((left, right) => left.localeCompare(right));
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

async function detectDllNames({ apiKey, appVersion, modId }) {
  const query = `
    query ModFileContents($filter: ModFileContentSearchFilter, $offset: Int, $count: Int) {
      modFileContents(filter: $filter, offset: $offset, count: $count) {
        totalCount
        nodesCount
        nodes {
          fileName
          filePath
          fileExtension
        }
      }
    }
  `;

  const variables = {
    filter: {
      modId: [{ value: String(modId), op: "EQUALS" }],
      fileExtensionExact: [{ value: "dll", op: "EQUALS" }],
    },
    offset: 0,
    count: 200,
  };

  try {
    const response = await nexusGraphql(query, variables, apiKey, appVersion);
    const nodes = Array.isArray(response?.data?.modFileContents?.nodes)
      ? response.data.modFileContents.nodes
      : [];

    return nodes
      .map((node) => node.fileName || path.basename(node.filePath || ""))
      .filter((name) => typeof name === "string" && /\.dll$/i.test(name))
      .map((name) => name.trim());
  } catch (error) {
    console.warn(`Warning: DLL detection failed for mod ${modId}. ${error.message}`);
    return [];
  }
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

async function nexusGraphql(query, variables, apiKey, appVersion) {
  const response = await fetchWithTimeout(GRAPHQL_URL, {
    method: "POST",
    headers: buildHeaders(apiKey, appVersion),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw await buildHttpError("Nexus GraphQL request failed", response);
  }

  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors.map((entry) => entry.message).join("; ");
    throw new Error(`GraphQL error: ${message}`);
  }

  return payload;
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

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
