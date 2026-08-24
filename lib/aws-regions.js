export const AWS_REGION_TO_NEM_REGION = {
  "ap-southeast-2": "NSW1",
  "ap-southeast-4": "VIC1",
};

export const SUPPORTED_AWS_REGIONS = Object.keys(AWS_REGION_TO_NEM_REGION);

export function getNemRegion(awsRegion) {
  return AWS_REGION_TO_NEM_REGION[awsRegion] || null;
}
