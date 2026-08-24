// AWS adapter. Reads inventory and CPU only — grid data lives in lib/grid-data.js
// and the two are joined in lib/fleet.js against one shared timeline.

import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
  DescribeRegionsCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { getNemRegion, SUPPORTED_AWS_REGIONS } from "@/lib/aws-regions";

export function getControlRegion() {
  return process.env.AWS_REGION || process.env.AWS_CONTROL_REGION || "ap-southeast-2";
}

function getLoadShiftCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY in the server environment.");
  }

  return {
    accessKeyId,
    secretAccessKey,
    ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
  };
}

export async function assumeCustomerRole(roleArn, externalId) {
  const sts = new STSClient({ credentials: getLoadShiftCredentials(), region: getControlRegion() });
  const { Credentials } = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: "LoadShiftReadOnly",
    ExternalId: externalId,
    DurationSeconds: 900,
  }));

  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
    throw new Error("AWS returned incomplete temporary credentials.");
  }

  return {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretAccessKey,
    sessionToken: Credentials.SessionToken,
  };
}

export async function getAvailableRegions(credentials) {
  const ec2 = new EC2Client({ region: getControlRegion(), credentials });
  const { Regions = [] } = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  const enabled = new Set(Regions.map((region) => region.RegionName));
  return SUPPORTED_AWS_REGIONS.filter((region) => enabled.has(region));
}

export async function listInstancesInRegion(region, credentials) {
  const ec2 = new EC2Client({ region, credentials });
  const instances = [];
  let nextToken;

  do {
    const response = await ec2.send(new DescribeInstancesCommand({
      NextToken: nextToken,
      Filters: [{ Name: "instance-state-name", Values: ["running"] }],
    }));

    for (const reservation of response.Reservations || []) {
      for (const instance of reservation.Instances || []) {
        const tags = Object.fromEntries((instance.Tags || []).map((tag) => [tag.Key, tag.Value]));
        instances.push({
          id: instance.InstanceId,
          name: tags.Name || instance.InstanceId,
          instanceType: instance.InstanceType,
          awsRegion: region,
          nemRegion: getNemRegion(region),
          launchTime: instance.LaunchTime,
          tags,
        });
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return instances;
}

export async function getCpuBuckets(region, instanceIds, credentials, startTime, endTime) {
  if (!instanceIds.length) return new Map();

  const cloudwatch = new CloudWatchClient({ region, credentials });
  const byInstance = new Map();

  // GetMetricData caps at 500 queries per call.
  for (let offset = 0; offset < instanceIds.length; offset += 500) {
    const chunk = instanceIds.slice(offset, offset + 500);
    const { MetricDataResults = [] } = await cloudwatch.send(new GetMetricDataCommand({
      EndTime: endTime,
      StartTime: startTime,
      ScanBy: "TimestampAscending",
      MetricDataQueries: chunk.map((instanceId, index) => ({
        Id: `cpu${index}`,
        ReturnData: true,
        MetricStat: {
          Metric: {
            Dimensions: [{ Name: "InstanceId", Value: instanceId }],
            MetricName: "CPUUtilization",
            Namespace: "AWS/EC2",
          },
          Period: 3600,
          Stat: "Average",
        },
      })),
    }));

    for (const result of MetricDataResults) {
      const index = Number(String(result.Id || "").replace("cpu", ""));
      if (!Number.isInteger(index) || !chunk[index]) continue;
      const byHour = new Map();
      (result.Timestamps || []).forEach((timestamp, position) => {
        const hour = new Date(timestamp);
        hour.setUTCMinutes(0, 0, 0);
        byHour.set(hour.toISOString(), Number(result.Values?.[position] || 0));
      });
      byInstance.set(chunk[index], byHour);
    }
  }

  return byInstance;
}

// ec2:DescribeInstanceTypes is already in the role we ask customers to create, so
// an instance type missing from the Teads table costs us nothing extra to estimate.
// Coefficients are fitted loosely to the Teads curve for modern Xeon/Graviton parts.
export async function getInstanceTypeSpecs(region, instanceTypes, credentials) {
  if (!instanceTypes.length) return new Map();

  const ec2 = new EC2Client({ region, credentials });
  const specs = new Map();

  for (let offset = 0; offset < instanceTypes.length; offset += 100) {
    const chunk = instanceTypes.slice(offset, offset + 100);
    try {
      const { InstanceTypes = [] } = await ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: chunk }));
      for (const entry of InstanceTypes) {
        specs.set(entry.InstanceType, {
          vcpus: entry.VCpuInfo?.DefaultVCpus || 2,
          memoryGib: (entry.MemoryInfo?.SizeInMiB || 2048) / 1024,
        });
      }
    } catch {
      // Non-fatal: callers fall back to a generic profile.
    }
  }

  return specs;
}

export function estimatePowerProfile(spec) {
  if (!spec) return { idleWatts: 12, maxWatts: 45, source: "generic" };
  return {
    idleWatts: Math.max(8, spec.vcpus * 2.0 + spec.memoryGib * 0.25),
    maxWatts: Math.max(20, spec.vcpus * 8.0 + spec.memoryGib * 0.4),
    source: "estimated",
  };
}
