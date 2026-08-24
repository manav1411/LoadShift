"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import GridSchedule from "@/app/ui/grid-schedule";
import SignOutButton from "@/app/ui/sign-out-button";

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

export default function AwsConnection({ initialConnection, userName }) {
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

  const policies = getPolicies(
    principalArn || "arn:aws:iam::<YOUR_LOADSHIFT_ACCOUNT_ID>:root",
    externalId || "<EXTERNAL_ID_FROM_LOADSHIFT>",
  );

  return (
    <div className="workspace-shell">
      <header className="workspace-nav">
        <div className="workspace-brand">
          <span>LoadShift</span>
          <small>{userName ? `Hello, ${userName}` : "Cloud carbon workspace"}</small>
        </div>
        <div className="workspace-actions">
          <span className={`aws-status ${connection ? "connected" : ""}`}><i />AWS {connection ? "connected" : "not connected"}</span>
          {connection && <button className="nav-button" disabled={isBusy} onClick={loadInstances} type="button">{isBusy ? "Refreshing…" : "Refresh"}</button>}
          {connection ? <button className="nav-button subtle" disabled={isBusy} onClick={disconnect} type="button">Disconnect</button> : <button className="nav-button primary" onClick={openInstructions} type="button">Connect AWS</button>}
          <SignOutButton />
        </div>
      </header>

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

      {error && !showInstructions && <p className="form-error workspace-error" role="alert">{error}</p>}

      {!connection && !showInstructions && (
        <div className="workspace-empty">
          <span className="schedule-eyebrow">Your workspace</span>
          <h1>Connect AWS to see your compute move through the NEM.</h1>
          <p>LoadShift uses read-only EC2 and CloudWatch data to estimate your footprint and show when the grid is cleaner.</p>
          <button className="submit-button" onClick={openInstructions} type="button">Connect AWS</button>
        </div>
      )}

      {connection && instances.length === 0 && (
        <div className="workspace-empty compact">
          <span className="schedule-eyebrow">AWS connected</span>
          <h1>Your grid model is ready.</h1>
          <p>Refresh EC2 data to build the interactive NEM view.</p>
          <button className="submit-button" onClick={loadInstances} type="button" disabled={isBusy}>{isBusy ? "Loading…" : "Load EC2 data"}</button>
        </div>
      )}

      {connection && instances.length > 0 && (
        <main className="workspace-main">
          <GridSchedule instances={instances} />
          <section className="aws-summary-strip" aria-label="AWS footprint summary">
            <div><span>Estimated EC2 footprint</span><strong>{measuredInstances.length > 0 ? `${totalKilograms.toFixed(3)} kg CO₂e` : "Not available"}</strong></div>
            <div><span>Running instances</span><strong>{instances.length}</strong></div>
            <div><span>Coverage</span><strong>24h</strong></div>
            {warnings.length > 0 && <div className="summary-warning"><span>Data note</span><strong>{warnings[0]}</strong></div>}
          </section>
        </main>
      )}
    </div>
  );
}
