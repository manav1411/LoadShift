// Single source of truth for NEM fuel-type identity: the fixed set of sources,
// their display order/colour/label, and the timestamp formatting both chart
// renderers (2D SVG fallback and 3D scene) need to build a legend.

export const SOURCE_ORDER = ["coal", "distillate", "gas", "hydro", "battery", "bioenergy", "wind", "solar"];

export const SOURCE_COLORS = {
  coal: "#43424a",
  distillate: "#c17a3d",
  gas: "#ff6f3c",
  hydro: "#2fb1ef",
  battery: "#5a5cf0",
  bioenergy: "#b544e8",
  wind: "#16e0a0",
  solar: "#ffd23f",
};

export const SOURCE_LABELS = {
  coal: "Coal",
  distillate: "Distillate",
  gas: "Gas",
  hydro: "Hydro",
  battery: "Battery",
  bioenergy: "Bioenergy",
  wind: "Wind",
  solar: "Solar",
};

// Open Electricity sometimes splits a fuel type into sub-keys (e.g. battery
// charging/discharging) — group by the part before the first underscore.
export function normaliseSourceKey(source) {
  return source.toLowerCase().split("_")[0];
}

export function aggregateSourceMix(sourceMix) {
  const totals = {};
  for (const [key, value] of Object.entries(sourceMix || {})) {
    const group = normaliseSourceKey(key);
    totals[group] = (totals[group] || 0) + (Number(value) || 0);
  }
  return totals;
}

export function formatHour(timestamp, { withMinute = false } = {}) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "numeric",
    ...(withMinute ? { minute: "2-digit" } : {}),
  }).format(new Date(timestamp));
}

// Every source, in a fixed order, for the 3D scene's always-visible legend.
export function getFullSourceLegend() {
  return SOURCE_ORDER.map((source) => ({ source, label: SOURCE_LABELS[source], color: SOURCE_COLORS[source] }));
}

// Just the sources present in one hour's mix, largest share first, for the 2D
// fallback's lighter-weight legend.
export function getSourceLegend(sourceMix = {}) {
  const totals = aggregateSourceMix(sourceMix);
  return Object.keys(totals)
    .sort((left, right) => (totals[right] || 0) - (totals[left] || 0))
    .slice(0, 6)
    .map((source) => ({
      source,
      label: SOURCE_LABELS[source] || source.replaceAll("_", " "),
      color: SOURCE_COLORS[source] || "#9b9b9b",
    }));
}
