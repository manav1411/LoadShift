import "./globals.css";

export const metadata = {
  title: "LoadShift",
  description: "Understand and reduce the carbon impact of your cloud workloads.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
