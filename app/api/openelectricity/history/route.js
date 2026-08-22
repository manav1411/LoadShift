import { NextResponse } from "next/server";
import {
  getHistoricalGenerationSnapshot,
  getSnapshotStorageInfo,
} from "@/lib/openelectricity-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh =
    searchParams.get("refresh") === "1" ||
    searchParams.get("refresh") === "true";

  try {
    const result = await getHistoricalGenerationSnapshot({ forceRefresh });

    return NextResponse.json(
      {
        ...result,
        storage: getSnapshotStorageInfo(),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to build the Open Electricity snapshot.",
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
        status: 500,
      },
    );
  }
}
