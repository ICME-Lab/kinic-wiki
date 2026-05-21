import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://wiki.kinic.xyz"),
  title: "Kinic Wiki Database Dashboard",
  description: "Browse, search, edit, and manage Kinic Wiki canister databases.",
  openGraph: {
    title: "Kinic Wiki Database Dashboard",
    description: "Browse, search, edit, and manage Kinic Wiki canister databases.",
    siteName: "Kinic Wiki",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Wiki Database Dashboard",
    description: "Browse, search, edit, and manage Kinic Wiki canister databases."
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
