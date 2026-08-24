import { redirect } from "next/navigation";
import AwsConnection from "@/app/ui/aws-connection";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims?.sub) {
    redirect("/");
  }

  const userId = claimsData.claims.sub;
  const [{ data: profile }, { data: awsConnection }, { data: userData }] = await Promise.all([
    supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle(),
    supabase.from("aws_connections").select("aws_account_id, connected_at, role_arn, status").eq("user_id", userId).maybeSingle(),
    supabase.auth.getUser(),
  ]);

  const metadata = userData?.user?.user_metadata || {};
  const name = profile?.display_name
    || metadata.display_name
    || metadata.full_name
    || metadata.name
    || claimsData.claims.email
    || "there";

  return (
    <main className="dashboard-page">
      <section className="dashboard-content">
        <AwsConnection
          initialConnection={awsConnection?.status === "connected" && awsConnection.role_arn ? {
            awsAccountId: awsConnection.aws_account_id,
            connectedAt: awsConnection.connected_at,
          } : null}
          userName={name}
        />
      </section>
    </main>
  );
}
