const TOKEN_TTL_MS = 10 * 60_000;
type SecretEnv = { CSRF_SECRET?: string };

function secret(env: SecretEnv): string {
  const value = env.CSRF_SECRET;
  if (!value || value.length < 16) throw new Error("csrf_not_configured");
  return value;
}

function encode(value: string): string { return btoa(unescape(encodeURIComponent(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decode(value: string): string { return decodeURIComponent(escape(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)))); }
function encodeBytes(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decodeBytes(value: string): Uint8Array { return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)), (char) => char.charCodeAt(0)); }

async function sign(env: SecretEnv, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return encodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

export async function issueCsrfToken(env: SecretEnv, actorSub: string, now = Date.now()): Promise<{ token: string; expiresAt: string }> {
  const expires = now + TOKEN_TTL_MS;
  const body = `${actorSub}.${expires}`;
  return { token: `${encode(body)}.${await sign(env, body)}`, expiresAt: new Date(expires).toISOString() };
}

export async function verifyCsrfToken(env: SecretEnv, actorSub: string, token: string, now = Date.now()): Promise<boolean> {
  try {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) return false;
    const body = decode(encoded);
    const dot = body.lastIndexOf(".");
    if (dot <= 0 || body.slice(0, dot) !== actorSub || Number(body.slice(dot + 1)) < now) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, decodeBytes(signature), new TextEncoder().encode(body));
  } catch { return false; }
}
