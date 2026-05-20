import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kinic Hermes Skill Evolution",
  description: "Inspect Kinic Hermes skill evolution jobs, proposals, and run evidence.",
  openGraph: {
    title: "Kinic Hermes Skill Evolution",
    description: "Inspect Kinic Hermes skill evolution jobs, proposals, and run evidence.",
    siteName: "Kinic Hermes",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Hermes Skill Evolution",
    description: "Inspect Kinic Hermes skill evolution jobs, proposals, and run evidence."
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
