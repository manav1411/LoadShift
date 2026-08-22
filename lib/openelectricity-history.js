import { OpenElectricityClient, getLastCompleteInterval } from "openelectricity";
import {
  createAdminClient,
  OPEN_ELECTRICITY_DATA_TABLE,
} from "./supabase/admin";

const DEFAULT_CACHE_MAX_AGE_HOURS = 24;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_INTERVAL = "5m";
const DEFAULT_NETWORK_CODE = "NEM";

const VALID_INTERVALS = new Set(["5m", "1h", "1d", "7d", "1M", "3M", "season", "1y", "fy"]);
const VALID_NETWORK_CODES = new Set(["NEM", "WEM", "AU"]);

let inFlightRefreshPromise = null;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normaliseNetworkCode(value) {
  return VALID_NETWORK_CODES.has(value) ? value : DEFAULT_NETWORK_CODE;
}

function normaliseInterval(value) {
  return VALID_INTERVALS.has(value) ? value : DEFAULT_INTERVAL;
}

function parseNaiveDateTime(dateTimeString) {
  const [datePart, timePart = "00:00:00"] = dateTimeString.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

function formatNaiveDateTime(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function subtractDaysFromNaiveDateTime(dateTimeString, days) {
  const date = parseNaiveDateTime(dateTimeString);
  date.setUTCDate(date.getUTCDate() - days);

  return formatNaiveDateTime(date);
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown Open Electricity error";
}

function roundNumber(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Number(value.toFixed(digits));
}

function buildStatistics(values) {
  if (values.length === 0) {
    return {
      count: 0,
      mean: null,
      median: null,
      std: null,
      min: null,
      max: null,
      total: null,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const mean = total / count;
  const midpoint = Math.floor(count / 2);
  const median =
    count % 2 === 0
      ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
      : sorted[midpoint];
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count;
  const std = Math.sqrt(variance);

  return {
    count,
    mean: roundNumber(mean),
    median: roundNumber(median),
    std: roundNumber(std),
    min: roundNumber(sorted[0]),
    max: roundNumber(sorted[count - 1]),
    total: roundNumber(total),
  };
}

function flattenNetworkSeries(seriesCollection) {
  const rows = [];

  for (const series of seriesCollection) {
    for (const result of series.results) {
      for (const [interval, value] of result.data) {
        rows.push({
          interval,
          intervalUtc: new Date(interval).toISOString(),
          network_code: series.network_code,
          ...result.columns,
          [series.metric]: value,
        });
      }
    }
  }

  return rows.sort((left, right) => {
    const byInterval = Date.parse(left.intervalUtc) - Date.parse(right.intervalUtc);

    if (byInterval !== 0) {
      return byInterval;
    }

    return String(left.fueltech_group ?? "").localeCompare(
      String(right.fueltech_group ?? ""),
    );
  });
}

function summariseByFueltechGroup(rows, metricKey) {
  const valuesByFueltechGroup = new Map();

  for (const row of rows) {
    const fueltechGroup =
      typeof row.fueltech_group === "string" ? row.fueltech_group : "unknown";
    const metricValue = row[metricKey];

    if (typeof metricValue !== "number" || Number.isNaN(metricValue)) {
      continue;
    }

    if (!valuesByFueltechGroup.has(fueltechGroup)) {
      valuesByFueltechGroup.set(fueltechGroup, []);
    }

    valuesByFueltechGroup.get(fueltechGroup).push(metricValue);
  }

  return Object.fromEntries(
    [...valuesByFueltechGroup.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fueltechGroup, values]) => [
        fueltechGroup,
        buildStatistics(values),
      ]),
  );
}

function getRequestConfig() {
  return {
    cacheMaxAgeHours: parsePositiveNumber(
      process.env.OPEN_ELECTRICITY_CACHE_MAX_AGE_HOURS,
      DEFAULT_CACHE_MAX_AGE_HOURS,
    ),
    interval: normaliseInterval(process.env.OPEN_ELECTRICITY_INTERVAL),
    lookbackDays: parsePositiveInteger(
      process.env.OPEN_ELECTRICITY_LOOKBACK_DAYS,
      DEFAULT_LOOKBACK_DAYS,
    ),
    metric: "power",
    networkCode: normaliseNetworkCode(process.env.OPEN_ELECTRICITY_NETWORK_CODE),
  };
}

function getRequestWindow(config) {
  const dateEnd = getLastCompleteInterval(config.networkCode);
  const dateStart = subtractDaysFromNaiveDateTime(dateEnd, config.lookbackDays);

  return { dateStart, dateEnd };
}

function isSnapshotStale(snapshot, maxAgeHours) {
  const fetchedAt = snapshot?.meta?.fetchedAt;

  if (!fetchedAt) {
    return true;
  }

  const fetchedAtMs = Date.parse(fetchedAt);

  if (Number.isNaN(fetchedAtMs)) {
    return true;
  }

  return Date.now() - fetchedAtMs > maxAgeHours * 60 * 60 * 1000;
}

function buildSnapshot(apiResponse, config, requestWindow) {
  const rawSeries = apiResponse.data;
  const rows = flattenNetworkSeries(rawSeries);
  const distinctIntervals = new Set(rows.map((row) => row.interval)).size;
  const fueltechGroups = [
    ...new Set(
      rows
        .map((row) => row.fueltech_group)
        .filter((value) => typeof value === "string"),
    ),
  ].sort((left, right) => left.localeCompare(right));

  return {
    meta: {
      apiCreatedAt: apiResponse.created_at ?? null,
      apiVersion: apiResponse.version ?? null,
      cacheMaxAgeHours: config.cacheMaxAgeHours,
      dateEnd: requestWindow.dateEnd,
      dateStart: requestWindow.dateStart,
      fetchedAt: new Date().toISOString(),
      fueltechGroups,
      groupings: rawSeries[0]?.groupings ?? [],
      interval: config.interval,
      intervalCount: distinctIntervals,
      lookbackDays: config.lookbackDays,
      metric: config.metric,
      networkCode: config.networkCode,
      networkTimezoneOffset: rawSeries[0]?.network_timezone_offset ?? null,
      rawRowCount: rows.length,
      rawSeriesCount: rawSeries.length,
      storageTable: OPEN_ELECTRICITY_DATA_TABLE,
      unit: rawSeries[0]?.unit ?? null,
    },
    raw: {
      rows,
      series: rawSeries,
    },
    statistics: {
      byFueltechGroup: summariseByFueltechGroup(rows, config.metric),
    },
  };
}

async function readStoredSnapshot() {
  const supabase = createAdminClient();
  const { data, error, count } = await supabase
    .from(OPEN_ELECTRICITY_DATA_TABLE)
    .select("data", { count: "exact" })
    .limit(1);

  if (error) {
    throw new Error(
      `Unable to read Open Electricity snapshot from Supabase: ${error.message}`,
    );
  }

  return {
    rowCount: count ?? data?.length ?? 0,
    snapshot: data?.[0]?.data ?? null,
  };
}

async function writeStoredSnapshot(snapshot) {
  const supabase = createAdminClient();
  const { count, error: countError } = await supabase
    .from(OPEN_ELECTRICITY_DATA_TABLE)
    .select("data", { count: "exact", head: true });

  if (countError) {
    throw new Error(
      `Unable to inspect Open Electricity storage in Supabase: ${countError.message}`,
    );
  }

  if ((count ?? 0) === 0) {
    const { error: insertError } = await supabase
      .from(OPEN_ELECTRICITY_DATA_TABLE)
      .insert({ data: snapshot });

    if (insertError) {
      throw new Error(
        `Unable to insert Open Electricity snapshot into Supabase: ${insertError.message}`,
      );
    }

    return;
  }

  const { error: updateError } = await supabase
    .from(OPEN_ELECTRICITY_DATA_TABLE)
    .update({ data: snapshot })
    .or("data.is.null,data.not.is.null");

  if (updateError) {
    throw new Error(
      `Unable to overwrite Open Electricity snapshot in Supabase: ${updateError.message}`,
    );
  }
}

async function refreshSnapshot() {
  const config = getRequestConfig();
  const apiKey =
    process.env.OPEN_ELECTRICITY_API_KEY || process.env.OPENELECTRICITY_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Missing OPEN_ELECTRICITY_API_KEY in .env.",
    );
  }

  const requestWindow = getRequestWindow(config);
  const client = new OpenElectricityClient({ apiKey });
  const { response } = await client.getNetworkData(
    config.networkCode,
    [config.metric],
    {
      dateEnd: requestWindow.dateEnd,
      dateStart: requestWindow.dateStart,
      interval: config.interval,
      primaryGrouping: "network",
      secondaryGrouping: ["fueltech_group"],
    },
  );
  const snapshot = buildSnapshot(response, config, requestWindow);

  await writeStoredSnapshot(snapshot);

  return snapshot;
}

export function getSnapshotStorageInfo() {
  return {
    provider: "supabase",
    table: OPEN_ELECTRICITY_DATA_TABLE,
  };
}

export function getSnapshotConfig() {
  return getRequestConfig();
}

export async function readHistoricalGenerationSnapshot() {
  const { snapshot } = await readStoredSnapshot();
  return snapshot;
}

export async function getHistoricalGenerationSnapshotStatus() {
  const config = getRequestConfig();
  const { snapshot, rowCount } = await readStoredSnapshot();

  return {
    config,
    exists: Boolean(snapshot),
    rowCount,
    stale: isSnapshotStale(snapshot, config.cacheMaxAgeHours),
    storage: getSnapshotStorageInfo(),
    snapshot: snapshot
      ? {
          dateEnd: snapshot.meta?.dateEnd ?? null,
          dateStart: snapshot.meta?.dateStart ?? null,
          fetchedAt: snapshot.meta?.fetchedAt ?? null,
          fueltechGroups: snapshot.meta?.fueltechGroups ?? [],
          interval: snapshot.meta?.interval ?? null,
          intervalCount: snapshot.meta?.intervalCount ?? 0,
          rawRowCount: snapshot.meta?.rawRowCount ?? 0,
        }
      : null,
  };
}

export async function getHistoricalGenerationSnapshot(options = {}) {
  const { forceRefresh = false } = options;
  const config = getRequestConfig();
  const { snapshot: storedSnapshot } = await readStoredSnapshot();
  const stale = isSnapshotStale(storedSnapshot, config.cacheMaxAgeHours);

  if (!forceRefresh && storedSnapshot && !stale) {
    return {
      snapshot: storedSnapshot,
      source: "supabase",
      stale: false,
      storage: getSnapshotStorageInfo(),
      warning: null,
    };
  }

  if (!inFlightRefreshPromise) {
    inFlightRefreshPromise = refreshSnapshot().finally(() => {
      inFlightRefreshPromise = null;
    });
  }

  try {
    const snapshot = await inFlightRefreshPromise;

    return {
      snapshot,
      source: "api",
      stale: false,
      storage: getSnapshotStorageInfo(),
      warning: null,
    };
  } catch (error) {
    if (storedSnapshot) {
      return {
        snapshot: storedSnapshot,
        source: "stale-supabase",
        stale: true,
        storage: getSnapshotStorageInfo(),
        warning: getErrorMessage(error),
      };
    }

    throw error;
  }
}
