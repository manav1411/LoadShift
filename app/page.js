import { redirect } from "next/navigation";
import Link from "next/link";
import AuthPanel from "./ui/auth-panel";
import LiveGridTeaser from "./ui/live-grid-teaser";
import TopNav from "./ui/top-nav";
import { AWS_REGIONS } from "@/lib/aws-regions";
import { getRegionGridData, getWindow } from "@/lib/grid-data";
import { createClient } from "@/lib/supabase/server";

async function getLiveRegions() {
  try {
    const window = getWindow();
    return await Promise.all(
      Object.values(AWS_REGIONS).map(async (meta) => ({
        city: meta.city,
        buckets: await getRegionGridData(meta.nemRegion, window),
      })),
    );
  } catch {
    // Decorative on this page — if Open Electricity is unreachable, just skip it.
    return [];
  }
}

export default async function HomePage() {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();

  if (claimsData?.claims?.sub) {
    redirect("/dashboard");
  }

  const liveRegions = await getLiveRegions();

  return (
    <div className="landing-page">
      <TopNav />
      <main className="landing-hero">
        <div className="landing-copy">
          <span className="schedule-eyebrow">Run compute at cleaner times</span>
          <h1>LoadShift</h1>
          <AuthPanel />
          <div className="landing-links">
            <Link className="landing-method-link" href="/demo">Explore a sample fleet</Link>
          </div>
        </div>
        <LiveGridTeaser regions={liveRegions} />
      </main>
    </div>
  );
}
