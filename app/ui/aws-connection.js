"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const providers = [
  { id: "aws", name: "AWS", available: true },
  { id: "azure", name: "Azure", available: false },
  { id: "gcp", name: "GCP", available: false },
];

function getPolicies(principalArn, externalId) {
  return {
    trust: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: principalArn },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": externalId } },
      }],
    }, null, 2),
    permissions: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: [
          "cloudwatch:GetMetricData",
          "cloudwatch:GetMetricStatistics",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceTypes",
          "ec2:DescribeRegions",
        ],
        Resource: "*",
      }],
    }, null, 2),
  };
}

export default function AwsConnection({ initialConnection }) {
  const router = useRouter();
  const [showInstructions, setShowInstructions] = useState(false);
  const [externalId, setExternalId] = useState("");
  const [principalArn, setPrincipalArn] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [connection, setConnection] = useState(initialConnection || null);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [instances, setInstances] = useState([]);
  const [warnings, setWarnings] = useState([]);

  const measuredInstances = instances.filter((instance) => Number.isFinite(instance.kilograms));
  const totalKilograms = measuredInstances.reduce((total, instance) => total + instance.kilograms, 0);

  async function openInstructions() {
    setShowInstructions(true);
    setError("");
    const response = await fetch("/api/aws/connection");
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Unable to start the AWS connection flow.");
      return;
    }
    setExternalId(data.externalId || "");
    setPrincipalArn(data.principalArn || "");
  }

  async function connect() {
    setIsBusy(true);
    setError("");
    const response = await fetch("/api/aws/connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roleArn }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Unable to connect to AWS.");
      setIsBusy(false);
      return;
    }
    setConnection(data);
    setShowInstructions(false);
    setIsBusy(false);
    router.refresh();
  }

  async function disconnect() {
    if (!window.confirm("Disconnect this AWS account from LoadShift?")) return;
    setIsBusy(true);
    const response = await fetch("/api/aws/connection", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) setError(data.error || "Unable to disconnect AWS.");
    else {
      setConnection(null);
      setInstances([]);
      setWarnings([]);
    }
    setIsBusy(false);
    router.refresh();
  }

  async function loadInstances() {
    setIsBusy(true);
    setError("");
    const response = await fetch("/api/aws/instances");
    const data = await response.json();
    if (!response.ok) setError(data.error || "Unable to load AWS instances.");
    else {
      setInstances(data.instances || []);
      setWarnings(data.warnings || []);
    }
    setIsBusy(false);
  }

  const policies = getPolicies(principalArn || "arn:aws:iam::<YOUR_LOADSHIFT_ACCOUNT_ID>:root", externalId || "<EXTERNAL_ID_FROM_LOADSHIFT>");

  return (
    <section className="cloud-connections" aria-labelledby="connections-title">
      <div className="connections-heading">
        <div><h2 id="connections-title">Cloud connections</h2></div>
      </div>
      <div className="provider-cards">
        {providers.map((provider) => (
          <article className={`provider-card ${connection && provider.id === "aws" ? "connected" : ""}`} key={provider.id}>
            <div className="provider-card-top"><h3>{provider.name}</h3>{connection && provider.id === "aws" && <span className="connected-label">Connected</span>}</div>
            {provider.available ? (
              connection ? <><p>Read-only EC2 access is active for account {connection.awsAccountId || "your AWS account"}.</p><div className="provider-actions"><button type="button" onClick={loadInstances} disabled={isBusy}>{isBusy ? "Loading…" : "Refresh EC2 data"}</button><button type="button" onClick={disconnect} disabled={isBusy}>Disconnect</button></div></> : <><p>Read instance inventory and CPU utilisation with a read-only IAM role.</p><button type="button" onClick={openInstructions}>Connect AWS</button></>
            ) : <><p></p><button type="button" disabled>Coming soon</button></>}
          </article>
        ))}
      </div>
      {showInstructions && !connection && (
        <div className="aws-instructions">
          <div className="instructions-header"><div><h3>Connect AWS securely</h3><p>LoadShift never asks for your AWS access keys. Create a cross-account role with the policies below.</p></div><button type="button" onClick={() => setShowInstructions(false)}>Close</button></div>
          <ol>
            <li>In AWS IAM, create a role named <strong>LoadShiftReadOnly</strong>.</li>
            <li>Use this as the role&apos;s trust policy:</li>
          </ol>
          <pre>{policies.trust}</pre>
          <ol start="3"><li>Attach this permissions policy to the role:</li></ol>
          <pre>{policies.permissions}</pre>
          <ol start="4"><li>Copy the role ARN and paste it here:</li></ol>
          <label className="role-input">IAM role ARN<input value={roleArn} onChange={(event) => setRoleArn(event.target.value)} placeholder="arn:aws:iam::123456789012:role/LoadShiftReadOnly" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="submit-button" type="button" onClick={connect} disabled={isBusy || !roleArn}>{isBusy ? "Checking role…" : "Connect and verify role"}</button>
        </div>
      )}
      {error && !showInstructions && <p className="form-error" role="alert">{error}</p>}
      {connection && instances.length > 0 && <div className="aws-inventory"><div className="inventory-summary"><div><h3>Measured EC2 footprint</h3><p>Last 24 completed hours across supported AWS regions</p></div><strong>{measuredInstances.length > 0 ? `${totalKilograms.toFixed(3)} kg CO₂e` : "Not available yet"}</strong></div><ul className="inventory-list">{instances.map((instance) => <li key={instance.id}><span><strong>{instance.name}</strong><small>{instance.instanceType} · {instance.region} · {Number.isFinite(instance.averageCpuUtilisation) ? `${instance.averageCpuUtilisation.toFixed(1)}% avg CPU` : "No CPU data"}</small></span><strong>{instance.kilograms == null ? "Profile unavailable" : `${instance.kilograms.toFixed(3)} kg CO₂e`}</strong></li>)}</ul>{warnings.map((warning) => <p className="estimate-note" key={warning}>{warning}</p>)}</div>}
    </section>
  );
}
