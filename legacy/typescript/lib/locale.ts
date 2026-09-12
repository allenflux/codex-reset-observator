export type DocumentLocale = "ja" | "en" | "zh";

export function getDocumentLocale(pathname: string): DocumentLocale {
  if (pathname === "/en" || pathname.startsWith("/en/")) {
    return "en";
  }

  if (pathname === "/zh" || pathname.startsWith("/zh/")) {
    return "zh";
  }

  return "ja";
}
