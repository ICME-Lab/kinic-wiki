import type { Metadata } from "next";
import "./globals.css";
import { AppHeader } from "./app-header";
import { AppSessionProvider } from "./app-session-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export const metadata: Metadata = {
  metadataBase: new URL("https://wiki.kinic.xyz"),
  title: "Kinic Wiki AI Memory",
  description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management.",
  openGraph: {
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management.",
    siteName: "Kinic Wiki",
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "Kinic Wiki AI Memory",
    description: "Use Kinic Wiki as canister-backed AI memory through kinic-vfs-cli, with browser tools for browsing and management."
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppSessionProvider>
          <TooltipProvider delayDuration={120}>
            <AppHeader />
            {children}
          </TooltipProvider>
        </AppSessionProvider>
      </body>
    </html>
  );
}
