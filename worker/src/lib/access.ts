type KeyImportParams = Parameters<typeof crypto.subtle.importKey>[2];
type VerifyParams = Parameters<typeof crypto.subtle.verify>[0];

interface JwtVerifyAlgs {
  importParams: KeyImportParams;
  verifyParams: VerifyParams;
}

function algsFor(alg: string): JwtVerifyAlgs {
  if (alg === "ES384") {
    return {
      importParams: { name: "ECDSA", namedCurve: "P-384" },
      verifyParams: { name: "ECDSA", hash: "SHA-384" },
    };
  }
  return {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  };
}

export interface AccessIdentity {
  sub: string;
  email: string;
  name: string;
}

interface JwtParts {
  header: { alg: string; kid: string };
  payload: {
    iss: string;
    aud?: string | string[];
    sub: string;
    email: string;
    name?: string;
    exp: number;
    common_name?: string;
  };
  signature: Uint8Array;
  signedContent: string;
}

const keysCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
const KEYS_TTL_MS = 60 * 60 * 1000;

function base64UrlDecodeBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwt(token: string): JwtParts {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(parts[0]!))) as JwtParts["header"];
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(parts[1]!))) as JwtParts["payload"];
  return {
    header,
    payload,
    signature: base64UrlDecodeBytes(parts[2]!),
    signedContent: `${parts[0]}.${parts[1]}`,
  };
}

async function fetchTeamKeys(teamDomain: string): Promise<JsonWebKey[]> {
  const cached = keysCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < KEYS_TTL_MS) return cached.keys;
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`keys_fetch_failed_${res.status}`);
  const data = (await res.json()) as { keys?: JsonWebKey[] };
  if (!data.keys?.length) throw new Error("no_team_keys");
  keysCache.set(teamDomain, { keys: data.keys, fetchedAt: Date.now() });
  return data.keys;
}

export async function verifyAccessAssertion(
  assertion: string,
  teamDomain: string,
  expectedAud: string
): Promise<AccessIdentity> {
  const { header, payload, signature, signedContent } = decodeJwt(assertion);

  if (header.alg !== "ES384" && header.alg !== "RS256") throw new Error("unexpected_alg");
  const { importParams, verifyParams } = algsFor(header.alg);
  const issuer = `https://${teamDomain}`;
  if (!payload.iss.startsWith(issuer)) throw new Error("issuer_mismatch");
  if (expectedAud) {
    const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!auds.includes(expectedAud)) throw new Error("audience_mismatch");
  }
  if (payload.exp * 1000 < Date.now()) throw new Error("token_expired");
  if (!payload.sub) throw new Error("missing_subject");

  const keys = await fetchTeamKeys(teamDomain);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) {
    keysCache.delete(teamDomain);
    throw new Error("unknown_key_id");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    importParams,
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    verifyParams,
    key,
    signature as unknown as ArrayBuffer,
    new TextEncoder().encode(signedContent)
  );
  if (!valid) throw new Error("invalid_signature");

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.common_name ?? payload.name ?? payload.email,
  };
}

export function extractAssertion(req: Request): string | null {
  const header = req.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match?.[1] ?? null;
}
