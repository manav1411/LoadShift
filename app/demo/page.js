import Link from "next/link";
import FleetConsole from "@/app/ui/fleet-console";
import TopNav from "@/app/ui/top-nav";

export const metadata = {
  title: "Sample fleet — LoadShift",
  description: "Explore LoadShift against a sample AWS fleet running on the NEM.",
};

export default function DemoPage() {
  return (
    <main className="dashboard-page">
      <section className="dashboard-content">
        <div className="workspace-shell">
          <TopNav>
            <span className="aws-status demo">Sample fleet</span>
            <Link className="nav-button primary" href="/">Connect your own</Link>
          </TopNav>
          <main className="workspace-main">
            <FleetConsole demo />
          </main>
        </div>
      </section>
    </main>
  );
}
