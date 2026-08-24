import { NextResponse } from "next/server";
import { getAwsInventory } from "@/lib/aws-carbon";
import { getClaims } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase, claims } = await getClaims();
    if (!claims?.sub) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const { data: connection, error: connectionError } = await supabase
      .from("aws_connections")
      .select("role_arn, external_id")
      .eq("user_id", claims.sub)
      .maybeSingle();

    if (connectionError) throw new Error(connectionError.message);
    if (!connection?.role_arn || !connection.external_id) {
      return NextResponse.json({ error: "AWS is not connected." }, { status: 400 });
    }

    const { data: profiles, error: profilesError } = await supabase
      .from("ec2_power_profiles")
      .select("instance_type, idle_watts, max_watts");

    if (profilesError && profilesError.code !== "PGRST205") throw new Error(profilesError.message);
    const result = await getAwsInventory({
      externalId: connection.external_id,
      profiles: profiles || [],
      roleArn: connection.role_arn,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load AWS instances." }, { status: 500 });
  }
}
