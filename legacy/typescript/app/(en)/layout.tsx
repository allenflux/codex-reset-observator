import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SiteJsonLd } from "@/components/SiteJsonLd";
import { getRootMetadata } from "@/lib/siteMetadata";
import "../globals.css";

export const metadata: Metadata = getRootMetadata("en");

export default function EnglishRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteJsonLd locale="en" />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
