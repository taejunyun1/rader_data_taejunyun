import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createSource } from "../ingestion/store";
import { previewHomepagePublication, publishHomepagePublication, withdrawHomepagePublication } from "../publication/service";
import { compareAndSwapCurrent, readCurrentPublication } from "../publication/storage";
import { deleteSourcePermanently } from "./deleteSource";
const input = (name: string, original: string) => ({kind: "NOTE" as const, title: name, original, extractedText: original, origin: `manual:${name}`});
describe("publication deletion interlock", () => {
  it("creates a null tombstone only when current and publication history are empty", async () => {
    const source=await seed("first-ever-delete");
    await deleteSourcePermanently(env,{sourceId:source.sourceId,confirmTitle:"first-ever-delete"});
    expect(await readCurrentPublication(env.PUBLICATIONS)).toMatchObject({exists:true,wrapper:{payload:{state:"WITHDRAWN",withdrawnPublicationId:null,withdrawnContentHash:null}}});
  });
  it("a withdrawn publication must support republishing", async () => {
    await env.PUBLICATIONS.delete("homepage/current-research.json");
    const source = await createSource(env as unknown as Env, input("republish", "publication material"));
    const sessionId = crypto.randomUUID();
    const output = { keywords: ["빛"], thoughts_fragments: ["생각"], questions: ["질문"], read_next: [], research_gaps: [], research_directions: ["방향"], artwork_directions: [] };
    await env.DB.prepare("INSERT INTO distill_sessions (id,sources_used_json,output_json,created_at) VALUES (?,?,?,?)")
      .bind(sessionId, JSON.stringify([{id: source.sourceId, title: "republish"}]), JSON.stringify(output), new Date().toISOString()).run();
    const deferred: Promise<unknown>[] = [];
    const defer = (p: Promise<unknown>) => { deferred.push(p); };
    const preview = await previewHomepagePublication(env, sessionId);
    const published = await publishHomepagePublication(env, {sessionId, expectedContentHash: preview.contentHash, expectedCurrentRevision: preview.currentRevision, actorSub: "audit", defer});
    await withdrawHomepagePublication(env, {expectedPublicationId: published.publication.publicationId, expectedContentHash: preview.contentHash, expectedCurrentRevision: published.currentRevision, actorSub: "audit", defer});
    const next = await previewHomepagePublication(env, sessionId);
    try {
      await expect(publishHomepagePublication(env, {sessionId, expectedContentHash: next.contentHash, expectedCurrentRevision: next.currentRevision, actorSub: "audit", defer})).resolves.toMatchObject({ok:true});
    } finally { await Promise.all(deferred); }
  });

  it("deletion must block a source used by the current publication", async () => {
    await env.PUBLICATIONS.delete("homepage/current-research.json");
    const source = await createSource(env as unknown as Env, input("delete-public", "published source bytes"));
    const sessionId = crypto.randomUUID();
    const output = { keywords: ["빛"], thoughts_fragments: ["생각"], questions: ["질문"], read_next: [], research_gaps: [], research_directions: ["방향"], artwork_directions: [] };
    await env.DB.prepare("INSERT INTO distill_sessions (id,sources_used_json,output_json,created_at) VALUES (?,?,?,?)")
      .bind(sessionId, JSON.stringify([{id: source.sourceId, title: "delete-public"}]), JSON.stringify(output), new Date().toISOString()).run();
    const deferred: Promise<unknown>[] = [];
    const preview = await previewHomepagePublication(env, sessionId);
    await publishHomepagePublication(env, {sessionId, expectedContentHash: preview.contentHash, expectedCurrentRevision: preview.currentRevision, actorSub: "audit", defer: p => {deferred.push(p);}});
    let rejected = false;
    try { await deleteSourcePermanently(env, {sourceId: source.sourceId, confirmTitle: "delete-public"}); } catch { rejected = true; }
    await Promise.all(deferred);
    const current = await readCurrentPublication(env.PUBLICATIONS);
    expect(rejected).toBe(true);
    expect(await env.DB.prepare("SELECT id FROM sources WHERE id=?").bind(source.sourceId).first()).not.toBeNull();
    if (!current.exists || current.wrapper.payload.state !== "EXPLORING") throw new Error("expected publication");
    await withdrawHomepagePublication(env, {expectedPublicationId: current.wrapper.payload.publicationId, expectedContentHash: current.wrapper.payload.contentHash, expectedCurrentRevision: current.currentRevision, actorSub:"audit",defer:()=>{}});
    await expect(deleteSourcePermanently(env,{sourceId:source.sourceId,confirmTitle:"delete-public"})).resolves.toMatchObject({deletedSourceId:source.sourceId});
  });

});

async function seed(name: string) { return createSource(env as unknown as Env, input(name, `original bytes ${name}`)); }
function bucketProxy(put: (...args: any[]) => any): R2Bucket {
 return new Proxy(env.PUBLICATIONS, {get(target, key) {
  if (key === "put") return put;
  const value = Reflect.get(target,key); return typeof value === "function" ? value.bind(target) : value;
 }});
}
it("changes the current ETag while preserving an unrelated tombstone", async () => {
 await env.PUBLICATIONS.delete("homepage/current-research.json");
 // Per-test D1 state may contain preceding publications: create an explicit tombstone.
 const missing = await readCurrentPublication(env.PUBLICATIONS);
 await compareAndSwapCurrent(env.PUBLICATIONS, missing, {schemaVersion:1,kind:"CURRENT_RESEARCH",source:"research-radar",state:"WITHDRAWN",withdrawnAt:new Date().toISOString(),withdrawnPublicationId:null,withdrawnContentHash:null});
 const before = await readCurrentPublication(env.PUBLICATIONS);
 const source = await seed("unpublished");
 await deleteSourcePermanently(env,{sourceId:source.sourceId,confirmTitle:"unpublished"});
 expect((await readCurrentPublication(env.PUBLICATIONS)).currentRevision).not.toBe(before.currentRevision);
});
it("fails closed if missing current has publication history", async () => {
 const source = await seed("missing-current");
 const sessionId=crypto.randomUUID(); const at=new Date().toISOString();
 await env.DB.prepare("INSERT INTO distill_sessions(id,output_json,sources_used_json,created_at) VALUES (?, '{}', '[]', ?)").bind(sessionId,at).run();
 await env.DB.prepare("INSERT INTO homepage_publications(id,distill_session_id,status,content_hash,created_at,updated_at) VALUES (?,?,'FAILED',?,?,?)").bind(crypto.randomUUID(),sessionId,"a".repeat(64),at,at).run();
 await env.PUBLICATIONS.delete("homepage/current-research.json");
 await expect(deleteSourcePermanently(env,{sourceId:source.sourceId,confirmTitle:"missing-current"})).rejects.toMatchObject({code:"publication_ledger_unavailable"});
 expect(await env.DB.prepare("SELECT id FROM sources WHERE id=?").bind(source.sourceId).first()).not.toBeNull();
});
it("a definite fence conflict releases the source claim and does not delete originals", async () => {
 const source=await seed("conflict");
 const current=await readCurrentPublication(env.PUBLICATIONS);
 await compareAndSwapCurrent(env.PUBLICATIONS,current,{schemaVersion:1,kind:"CURRENT_RESEARCH",source:"research-radar",state:"WITHDRAWN",withdrawnAt:new Date().toISOString(),withdrawnPublicationId:null,withdrawnContentHash:null});
 await expect(deleteSourcePermanently({...env,PUBLICATIONS:bucketProxy(async()=>null)},{sourceId:source.sourceId,confirmTitle:"conflict"})).rejects.toMatchObject({code:"publication_state_changed"});
 expect(await env.DB.prepare("SELECT source_id FROM source_deletion_claims WHERE source_id=?").bind(source.sourceId).first()).toBeNull();
 expect(await env.DB.prepare("SELECT id FROM sources WHERE id=?").bind(source.sourceId).first()).not.toBeNull();
});
it("deletion holds the publication lease through the current fence", async () => {
 const source=await seed("race");
 const current=await readCurrentPublication(env.PUBLICATIONS);
 await compareAndSwapCurrent(env.PUBLICATIONS,current,{schemaVersion:1,kind:"CURRENT_RESEARCH",source:"research-radar",state:"WITHDRAWN",withdrawnAt:new Date().toISOString(),withdrawnPublicationId:null,withdrawnContentHash:null});
 const bucket=bucketProxy(async (...args: Parameters<R2Bucket['put']>)=>{
   await expect(publishHomepagePublication(env,{sessionId:"unused",expectedContentHash:"",expectedCurrentRevision:"",actorSub:"test",defer:()=>{}})).rejects.toMatchObject({code:"publication_in_progress"});
   return env.PUBLICATIONS.put(...args);
 });
 await expect(deleteSourcePermanently({...env,PUBLICATIONS:bucket},{sourceId:source.sourceId,confirmTitle:"race"})).resolves.toMatchObject({deletedSourceId:source.sourceId});
});
it("retains a claim when a successful fence is followed by lease loss", async () => {
 const source=await seed("lost-lease");
 const current=await readCurrentPublication(env.PUBLICATIONS);
 await compareAndSwapCurrent(env.PUBLICATIONS,current,{schemaVersion:1,kind:"CURRENT_RESEARCH",source:"research-radar",state:"WITHDRAWN",withdrawnAt:new Date().toISOString(),withdrawnPublicationId:null,withdrawnContentHash:null});
 const bucket=bucketProxy(async (...args: Parameters<R2Bucket['put']>)=>{
   const result=await env.PUBLICATIONS.put(...args);
   await env.DB.prepare("UPDATE homepage_publication_lease SET generation=generation+1,owner_token=NULL,expires_at_ms=NULL").run();
   return result;
 });
 await expect(deleteSourcePermanently({...env,PUBLICATIONS:bucket},{sourceId:source.sourceId,confirmTitle:"lost-lease"})).rejects.toThrow();
 expect(await env.DB.prepare("SELECT source_id FROM source_deletion_claims WHERE source_id=?").bind(source.sourceId).first()).not.toBeNull();
 expect(await env.DB.prepare("SELECT id FROM sources WHERE id=?").bind(source.sourceId).first()).not.toBeNull();
});
it("rejects a stale publication generation in the final D1 transaction", async () => {
 const source=await seed("stale-generation");
 const current=await readCurrentPublication(env.PUBLICATIONS);
 await compareAndSwapCurrent(env.PUBLICATIONS,current,{schemaVersion:1,kind:"CURRENT_RESEARCH",source:"research-radar",state:"WITHDRAWN",withdrawnAt:new Date().toISOString(),withdrawnPublicationId:null,withdrawnContentHash:null});
 const db=new Proxy(env.DB,{get(target,key){
   if(key==='batch') return async (statements:D1PreparedStatement[])=>{
     await env.DB.prepare("UPDATE homepage_publication_lease SET generation=generation+1,owner_token=NULL,expires_at_ms=NULL").run();
     return env.DB.batch(statements);
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(deleteSourcePermanently({...env,DB:db},{sourceId:source.sourceId,confirmTitle:"stale-generation"})).rejects.toThrow();
 expect(await env.DB.prepare("SELECT id FROM sources WHERE id=?").bind(source.sourceId).first()).not.toBeNull();
 expect(await env.DB.prepare("SELECT id FROM source_versions WHERE source_id=?").bind(source.sourceId).first()).not.toBeNull();
});
