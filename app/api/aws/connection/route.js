import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { NextResponse } from "next/server";
import { assumeCustomerRole } from "@/lib/aws-carbon";
import { getClaims } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getPrincipalArn() {
  return process.env.AWS_LOADSHIFT_PRINCIPAL_ARN
    || (process.env.AWS_LOADSHIFT_ACCOUNT_ID
      ? `arn:aws:iam::${process.env.AWS_LOADSHIFT_ACCOUNT_ID}:root`
      : "arn:aws:iam::<YOUR_LOADSHIFT_ACCOUNT_ID>:root");
}

function isRoleArn(value) {
  return /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\-/]+$/.test(value || "");
}

async function getConnection(supabase, userId) {
  const { data, error } = await supabase
    .from("aws_connections")
    .select("role_arn, external_id, aws_account_id, connected_at, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error && error.code !== "PGRST205") throw new Error(error.message);
  return data;
}

export async function GET() {
  try {
    const { supabase, claims } = await getClaims();
    if (!claims?.sub) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const connection = await getConnection(supabase, claims.sub);

    if (connection?.status === "connected" && connection.role_arn) {
      return NextResponse.json({
        connected: true,
        awsAccountId: connection.aws_account_id,
        connectedAt: connection.connected_at,
        principalArn: getPrincipalArn(),
      });
    }

    const externalId = connection?.external_id || `loadshift-${crypto.randomUUID()}`;
    const { error } = await supabase.from("aws_connections").upsert({
      external_id: externalId,
      user_id: claims.sub,
    });

    if (error) throw new Error(error.message);
    return NextResponse.json({ connected: false, externalId, principalArn: getPrincipalArn() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to prepare AWS connection." }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { supabase, claims } = await getClaims();
    if (!claims?.sub) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const body = await request.json();
    const roleArn = String(body.roleArn || "").trim();
    const connection = await getConnection(supabase, claims.sub);

    if (!connection?.external_id) throw new Error("Start the AWS connection flow again to generate an external ID.");
    if (!isRoleArn(roleArn)) throw new Error("Enter a valid IAM role ARN, for example arn:aws:iam::123456789012:role/LoadShiftReadOnly.");

    const temporaryCredentials = await assumeCustomerRole(roleArn, connection.external_id);
    const sts = new STSClient({ region: process.env.AWS_CONTROL_REGION || "ap-southeast-2", credentials: temporaryCredentials });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const { error } = await supabase.from("aws_connections").upsert({
      aws_account_id: identity.Account || null,
      connected_at: new Date().toISOString(),
      external_id: connection.external_id,
      role_arn: roleArn,
      status: "connected",
      user_id: claims.sub,
    });

    if (error) throw new Error(error.message);
    return NextResponse.json({ connected: true, awsAccountId: identity.Account || null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to connect to AWS." }, { status: 400 });
  }
}

export async function DELETE() {
  try {
    const { supabase, claims } = await getClaims();
    if (!claims?.sub) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const { error } = await supabase.from("aws_connections").delete().eq("user_id", claims.sub);
    if (error) throw new Error(error.message);
    return NextResponse.json({ connected: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to disconnect AWS." }, { status: 400 });
  }
}
