import { redirect } from "next/navigation";
import SignOutButton from "@/app/ui/sign-out-button";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims?.sub) {
    redirect("/");
  }

  const userId = claimsData.claims.sub;
  const [{ data: profile }, { data: workloads }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
    supabase.from("workloads").select("id, name, provider, status").eq("user_id", userId).order("created_at", { ascending: false }),
  ]);

  const name = profile?.display_name || claimsData.claims.email || "there";

  return (
    <main className="dashboard-page">
      <section className="dashboard-content">
        <header className="dashboard-header">
          <span>LoadShift</span>
          <SignOutButton />
        </header>
        <h1>Hello, {name}</h1>
        <p>Your private LoadShift workspace.</p>
        <section className="data-section" aria-labelledby="workloads-title">
          <h2 id="workloads-title">Your workloads</h2>
          {workloads?.length ? (
            <ul className="workload-list">
              {workloads.map((workload) => (
                <li key={workload.id}>
                  <span>{workload.name}</span>
                  <small>{workload.provider || "Unknown provider"} · {workload.status || "Not configured"}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No workloads yet.</p>
          )}
        </section>
      </section>
    </main>
  );
}
