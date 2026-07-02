import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
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
        <TooltipProvider delayDuration={120}>
          <div className="flex min-h-screen flex-col">{children}</div>
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </body>
    </html>
  );
}
