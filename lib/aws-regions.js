export const AWS_REGIONS = {
  "ap-southeast-2": { nemRegion: "NSW1", city: "Sydney", state: "New South Wales" },
  "ap-southeast-4": { nemRegion: "VIC1", city: "Melbourne", state: "Victoria" },
};

export const SUPPORTED_AWS_REGIONS = Object.keys(AWS_REGIONS);

export function getNemRegion(awsRegion) {
  return AWS_REGIONS[awsRegion]?.nemRegion || null;
}

// The one place that maps a NEM region back to its AWS region + display metadata,
// so callers never re-derive this lookup themselves.
export function getRegionMeta(nemRegion) {
  const awsRegion = Object.keys(AWS_REGIONS).find((key) => AWS_REGIONS[key].nemRegion === nemRegion);
  return awsRegion ? { awsRegion, ...AWS_REGIONS[awsRegion] } : null;
}
