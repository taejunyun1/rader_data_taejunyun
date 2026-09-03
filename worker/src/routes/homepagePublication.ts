import { Hono } from "hono";
import { getHomepagePublicationStatus, previewHomepagePublication, publishHomepagePublication, withdrawHomepagePublication, HomepagePublicationServiceError } from "../publication/service";
import { verifiedRequester, jsonError } from "../lib/httpErrors";
import { issueCsrfToken, verifyCsrfToken } from "../security/csrf";
import { readJson } from "../lib/requestBody";

const route = new Hono<{ Bindings: Env }>();

function csrfRequired(c: any): boolean { return !String(c.env.ENVIRONMENT).match(/^(development|test)$/); }

route.get("/sessions/:id/homepage-preview", async (c) => {
  try {
    const response = await previewHomepagePublication(c.env, c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return c.json(response);
  } catch (error) {
    const e = error instanceof HomepagePublicationServiceError ? error : null;
    return jsonError(c, e?.status ?? 500, e?.code ?? "internal_error");
  }
});

route.get("/homepage-publication/csrf", async (c) => {
  try { c.header("Cache-Control", "no-store"); return c.json(await issueCsrfToken(c.env as unknown as { CSRF_SECRET?: string }, verifiedRequester(c))); }
  catch (error) { return jsonError(c, 503, (error as Error).message); }
});

route.get("/homepage-publication", async (c) => {
  try { const response = await getHomepagePublicationStatus(c.env); c.header("Cache-Control", "no-store"); return c.json(response); }
  catch (error) { const e = error instanceof HomepagePublicationServiceError ? error : null; return jsonError(c, e?.status ?? 500, e?.code ?? "internal_error"); }
});

route.post("/sessions/:id/homepage-publish", async (c) => {
  const token = c.req.header("X-CSRF-Token");
  if (csrfRequired(c) && (!token || !(await verifyCsrfToken(c.env as unknown as { CSRF_SECRET?: string }, verifiedRequester(c), token)))) return jsonError(c, 403, "csrf_invalid");
  const body = await readJson<{ expectedContentHash?: string; expectedCurrentRevision?: string }>(c);
  if (!body?.expectedContentHash || !body.expectedCurrentRevision) return jsonError(c, 422, "publish_input_invalid");
  try {
    const response = await publishHomepagePublication(c.env, { sessionId: c.req.param("id"), expectedContentHash: body.expectedContentHash, expectedCurrentRevision: body.expectedCurrentRevision, actorSub: verifiedRequester(c), defer: (work) => c.executionCtx.waitUntil(work) });
    c.header("Cache-Control", "no-store");
    return c.json(response);
  } catch (error) { const e = error instanceof HomepagePublicationServiceError ? error : null; return jsonError(c, e?.status ?? 500, e?.code ?? "internal_error"); }
});

route.post("/homepage-publication/withdraw", async (c) => {
  const token = c.req.header("X-CSRF-Token");
  if (csrfRequired(c) && (!token || !(await verifyCsrfToken(c.env as unknown as { CSRF_SECRET?: string }, verifiedRequester(c), token)))) return jsonError(c, 403, "csrf_invalid");
  const body = await readJson<{ expectedPublicationId?: string; expectedContentHash?: string; expectedCurrentRevision?: string }>(c);
  if (!body?.expectedPublicationId || !body.expectedContentHash || !body.expectedCurrentRevision) return jsonError(c, 422, "withdraw_input_invalid");
  try { const response = await withdrawHomepagePublication(c.env, { ...body as { expectedPublicationId: string; expectedContentHash: string; expectedCurrentRevision: string }, actorSub: verifiedRequester(c), defer: (work) => c.executionCtx.waitUntil(work) }); c.header("Cache-Control", "no-store"); return c.json(response); }
  catch (error) { const e = error instanceof HomepagePublicationServiceError ? error : null; return jsonError(c, e?.status ?? 500, e?.code ?? "internal_error"); }
});

export default route;
