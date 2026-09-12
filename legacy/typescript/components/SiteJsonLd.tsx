import { getSiteJsonLd, type SiteLocale } from "@/lib/siteMetadata";

export function SiteJsonLd({ locale }: { locale: SiteLocale }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(getSiteJsonLd(locale)) }}
    />
  );
}
