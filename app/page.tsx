export default function Home() {
  return (
    <main style={{ maxWidth: 560, margin: "20vh auto", padding: 20, textAlign: "center" }}>
      <h1 style={{ fontWeight: 400 }}>Cleone API is running.</h1>
      <p style={{ color: "#777" }}>
        POST a repo to <code>/api/scan</code>. The UI is not wired up yet; see <code>index.html</code> for the prototype.
      </p>
    </main>
  );
}
