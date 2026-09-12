import { createHash, timingSafeEqual } from "node:crypto";

function extractBearerToken(authorizationHeader: string | null) {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer[ \t]+([^\s]+)$/i);
  return match?.[1] ?? null;
}

export function isBearerAuthorizationValid(
  authorizationHeader: string | null,
  expectedSecret: string | undefined,
) {
  const token = extractBearerToken(authorizationHeader);
  if (!token || !expectedSecret) return false;

  const candidateDigest = createHash("sha256").update(token).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}
