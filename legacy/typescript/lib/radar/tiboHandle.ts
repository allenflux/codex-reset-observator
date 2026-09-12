const TIBO_HANDLE_FALLBACK = "thsottiaux";
const SAFE_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

function normalizeHandle(value: string | null | undefined) {
  if (!value || !SAFE_HANDLE_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function getHandleFromSourceUrl(sourceUrl: string | null | undefined) {
  if (!sourceUrl) return null;

  try {
    const url = new URL(sourceUrl);
    const hostname = url.hostname.toLowerCase();
    if (
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname) ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 3 || segments[1]?.toLowerCase() !== "status") {
      return null;
    }

    return normalizeHandle(segments[0]);
  } catch {
    return null;
  }
}

function getHandleFromSavedLabel(savedLabel: string | null | undefined) {
  const match = savedLabel?.match(/@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/);
  return normalizeHandle(match?.[1]);
}

export function getTiboHandle(
  sourceUrl: string | null | undefined,
  savedLabel?: string | null,
) {
  return (
    getHandleFromSourceUrl(sourceUrl) ??
    getHandleFromSavedLabel(savedLabel) ??
    TIBO_HANDLE_FALLBACK
  );
}

export function getTiboDisplayLabel(
  sourceUrl: string | null | undefined,
  savedLabel?: string | null,
) {
  return `Tibo (@${getTiboHandle(sourceUrl, savedLabel)})`;
}
