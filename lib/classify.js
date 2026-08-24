// Decides whether a workload's compute can wait. The signals are deliberately
// cheap and explainable — every verdict carries the sentence that produced it,
// because "trust me" is not a useful thing to show someone about their own fleet.

const ALWAYS_ON_TOKENS = [
  "prod", "production", "api", "web", "www", "db", "database", "postgres", "mysql",
  "redis", "cache", "gateway", "proxy", "lb", "balancer", "frontend", "edge",
  "auth", "payment", "checkout", "realtime", "stream", "socket", "primary",
];

const FLEXIBLE_TOKENS = [
  "ci", "cd", "build", "builder", "batch", "worker", "runner", "etl", "job",
  "cron", "render", "encode", "transcode", "train", "training", "ml", "analytics",
  "report", "reporting", "backup", "archive", "index", "indexer", "sync",
  "scrape", "scraper", "crawler", "staging", "stage", "dev", "test", "qa", "sandbox",
];

const IDLE_CPU_THRESHOLD = 15;
const BURST_CPU_THRESHOLD = 25;
const STEADY_DEVIATION_THRESHOLD = 8;

function tokenise(value) {
  return String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchToken(tokens, list) {
  return list.find((candidate) => tokens.includes(candidate)) || null;
}

function readTagOverride(tags) {
  const raw = tags?.["loadshift:flexible"] ?? tags?.["loadshift:shiftable"];
  if (raw === undefined) return null;
  return /^(true|yes|1)$/i.test(String(raw));
}

function describeCpu(values) {
  if (!values.length) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean,
    deviation: Math.sqrt(variance),
    peak: Math.max(...values),
    idleHours: values.filter((value) => value < IDLE_CPU_THRESHOLD).length,
    total: values.length,
  };
}

// Returns { shiftable, reason, confidence } — confidence only steers UI emphasis.
export function classifyWorkload({ name, instanceType, tags, cpuValues = [] }) {
  const override = readTagOverride(tags);
  if (override !== null) {
    return {
      shiftable: override,
      reason: `Tagged \`loadshift:flexible = ${override}\` on the instance.`,
      confidence: "explicit",
    };
  }

  const tokens = [
    ...tokenise(name),
    ...tokenise(tags?.Name),
    ...tokenise(tags?.Role),
    ...tokenise(tags?.Service),
    ...tokenise(tags?.Environment),
    ...tokenise(instanceType),
  ];

  const alwaysOnToken = matchToken(tokens, ALWAYS_ON_TOKENS);
  if (alwaysOnToken) {
    return {
      shiftable: false,
      reason: `Named \`${alwaysOnToken}\` — treated as always-on until you say otherwise.`,
      confidence: "name",
    };
  }

  const flexibleToken = matchToken(tokens, FLEXIBLE_TOKENS);
  if (flexibleToken) {
    return {
      shiftable: true,
      reason: `Named \`${flexibleToken}\` — treated as flexible.`,
      confidence: "name",
    };
  }

  const cpu = describeCpu(cpuValues);
  if (!cpu) {
    return { shiftable: false, reason: "No CPU history yet — treated as always-on.", confidence: "none" };
  }

  if (cpu.idleHours >= cpu.total * 0.5 && cpu.peak >= BURST_CPU_THRESHOLD) {
    return {
      shiftable: true,
      reason: `CPU sits under ${IDLE_CPU_THRESHOLD}% for ${cpu.idleHours} of ${cpu.total} hours, peaking at ${cpu.peak.toFixed(0)}% — looks like scheduled work.`,
      confidence: "shape",
    };
  }

  if (cpu.deviation < STEADY_DEVIATION_THRESHOLD && cpu.mean > 10) {
    return {
      shiftable: false,
      reason: `Load holds near ${cpu.mean.toFixed(0)}% all day — looks like a live service.`,
      confidence: "shape",
    };
  }

  return {
    shiftable: false,
    reason: "No automatic classification — set the time-sensitivity yourself.",
    confidence: "default",
  };
}
