import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kinic Skill Registry",
  description: "Inspect Kinic Skill Registry snapshots, run evidence, and permissions.",
  openGraph: {
    title: "Kinic Skill Registry",
    description: "Inspect Kinic Skill Registry snapshots, run evidence, and permissions.",
    siteName: "Kinic Skill Registry",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Skill Registry",
    description: "Inspect Kinic Skill Registry snapshots, run evidence, and permissions."
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
