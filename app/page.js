import AuthPanel from "./ui/auth-panel";

export default function HomePage() {
  return (
    <main className="landing-page">
      <section className="welcome" aria-labelledby="welcome-title">
        <h1 id="welcome-title">Welcome to LoadShift</h1>
        <p>Understand and reduce the carbon impact of your cloud workloads.</p>
        <AuthPanel />
      </section>
    </main>
  );
}
