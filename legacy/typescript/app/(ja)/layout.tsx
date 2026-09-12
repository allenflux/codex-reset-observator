import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next";
import { SiteJsonLd } from "@/components/SiteJsonLd";
import { getRootMetadata } from "@/lib/siteMetadata";
import "../globals.css";

export const metadata: Metadata = getRootMetadata("ja");

export default function JapaneseRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <SiteJsonLd locale="ja" />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
