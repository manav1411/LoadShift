import { NextResponse } from "next/server";
import { buildDemoFleet } from "@/lib/demo-fleet";
import { getFleet } from "@/lib/fleet";
import { getClaims } from "@/lib/supabase/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    if (new URL(request.url).searchParams.get("demo") === "1") {
      return NextResponse.json(buildDemoFleet(), { headers: { "Cache-Control": "no-store" } });
    }

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

    const fleet = await getFleet({
      roleArn: connection.role_arn,
      externalId: connection.external_id,
      profiles: profiles || [],
    });

    return NextResponse.json(fleet, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load your fleet." },
      { status: 500 },
    );
  }
}
