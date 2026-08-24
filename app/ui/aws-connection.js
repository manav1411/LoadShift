"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import FleetConsole from "@/app/ui/fleet-console";
import SignOutButton from "@/app/ui/sign-out-button";
import TopNav from "@/app/ui/top-nav";

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
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

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
    setDemoMode(false);
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
    else setConnection(null);
    setIsBusy(false);
    router.refresh();
  }

  const policies = getPolicies(
    principalArn || "arn:aws:iam::<YOUR_LOADSHIFT_ACCOUNT_ID>:root",
    externalId || "<EXTERNAL_ID_FROM_LOADSHIFT>",
  );
  const showConsole = Boolean(connection) || demoMode;

  return (
    <div className="workspace-shell">
      <TopNav>
        {demoMode && !connection && <span className="aws-status demo">Sample fleet</span>}
        {connection && <span className="aws-status connected">AWS connected</span>}
        {demoMode && !connection && (
          <button className="nav-button" onClick={() => setDemoMode(false)} type="button">Exit sample</button>
        )}
        {connection ? (
          <button className="nav-button danger" disabled={isBusy} onClick={disconnect} type="button">Disconnect</button>
        ) : (
          <button className="nav-button primary" onClick={openInstructions} type="button">Connect AWS</button>
        )}
        <SignOutButton />
      </TopNav>

      {showInstructions && !connection && (
        <div className="aws-instructions">
          <div className="instructions-header">
            <div>
              <h3>Connect AWS securely</h3>
              <p>LoadShift never asks for your AWS access keys. Create a cross-account role with the policies below.</p>
            </div>
            <button onClick={() => setShowInstructions(false)} type="button">Close</button>
          </div>
          <ol>
            <li>In AWS IAM, create a role named <strong>LoadShiftReadOnly</strong>.</li>
            <li>Use this as the role&apos;s trust policy:</li>
          </ol>
          <pre>{policies.trust}</pre>
          <ol start="3"><li>Attach this permissions policy to the role:</li></ol>
          <pre>{policies.permissions}</pre>
          <ol start="4"><li>Copy the role ARN and paste it here:</li></ol>
          <label className="role-input">
            IAM role ARN
            <input onChange={(event) => setRoleArn(event.target.value)} placeholder="arn:aws:iam::123456789012:role/LoadShiftReadOnly" value={roleArn} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="submit-button" disabled={isBusy || !roleArn} onClick={connect} type="button">
            {isBusy ? "Checking role…" : "Connect and verify role"}
          </button>
        </div>
      )}

      {error && !showInstructions && <p className="form-error workspace-error" role="alert">{error}</p>}

      {!showConsole && !showInstructions && (
        <div className="workspace-empty">
          <span className="schedule-eyebrow">{userName ? `Welcome, ${userName}` : "Your workspace"}</span>
          <h1>Watch your compute move through the grid.</h1>
          <p>Connect AWS with read-only access and LoadShift will show what your EC2 footprint emitted over the last day — and what the same work would have cost the atmosphere run at a cleaner hour.</p>
          <div className="empty-actions">
            <button className="submit-button" onClick={openInstructions} type="button">Connect AWS</button>
            <button className="ghost-button" onClick={() => setDemoMode(true)} type="button">Explore a sample fleet</button>
          </div>
        </div>
      )}

      {showConsole && (
        <main className="workspace-main">
          <FleetConsole demo={demoMode && !connection} />
        </main>
      )}
    </div>
  );
}
