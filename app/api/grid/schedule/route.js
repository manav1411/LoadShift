import { NextResponse } from "next/server";
import { getGridSchedule } from "@/lib/grid-schedule";
import { getClaims } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const { claims } = await getClaims();
    if (!claims?.sub) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

    const body = await request.json();
    const result = await getGridSchedule({
      flexiblePercent: body.flexiblePercent,
      instances: Array.isArray(body.instances) ? body.instances : [],
      windowHours: body.windowHours,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to build the grid schedule." }, { status: 500 });
  }
}

