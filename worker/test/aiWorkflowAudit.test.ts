import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSource } from "../src/ingestion/store";
import { buildDistillContext } from "../src/distill/context";
import { analyzeDeepSource } from "../src/analysis/deepAnalyze";
import { callOpenAi } from "../src/lib/openai";
import { getResearchJob, failResearchJob } from "../src/jobs/store";
import { runDistill } from "../src/distill/run";
import { PRESETS } from "@radar/shared";

const aiEnv = () => ({ ...env, OPENAI_BASE_URL: "https://openai.test/v1", OPENAI_API_KEY: "test", MODEL_HIGH: "test-model", MODEL_DEEP: "test-review", MODEL_LOW: "test-model", MODEL_PRICING_JSON: '{"test-model":{"input":1,"output":1},"test-review":{"input":1,"output":1}}', MONTHLY_BUDGET_USD: "100" } as Env);
async function job(id: string) {
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO research_jobs (id,kind,status,input_json,dedupe_key,created_at,updated_at) VALUES (?,'DISTILL_RUN','RUNNING','{}',?,?,?)").bind(id,id,now,now).run();
}
async function source(name: string) {
  return createSource(aiEnv(), { kind: "NOTE", title: name, origin: "manual", canonicalUrl: `https://example.com/${name}`, original: name.repeat(1500), extractedText: name.repeat(1500), inputFormat: "PLAIN_TEXT", textScope: "FULLTEXT", extractionMethod: "MANUAL_TEXT" });
}
async function signal(sourceId: string, action: string, at = '2099-01-01T00:00:00.000Z') {
  await env.DB.prepare("INSERT INTO user_signals (id,source_id,action,weight,created_at) VALUES (?,?,?,3,?)").bind(crypto.randomUUID(),sourceId,action,at).run();
}
const completion = (data: unknown) => Response.json({ choices: [{message: {content: JSON.stringify(data)}}], usage: {prompt_tokens: 10, completion_tokens: 5} });
const deep = { overview: "original overview", arguments: [], structure: [], quotes: [], concepts: [], uncertainties: [], connections: [], researchUses: [], limitations: [] };
const distill = { keywords: ["빛"], thoughts_fragments: ["생각"], questions: ["질문"], read_next: [{title:"A reading",why_read:"reason"}], research_gaps: [{gap:"A gap",kind:"theory"}], research_directions: ["방향"], artwork_directions: [] };

describe("AI workflow audit invariants", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("selects fresh keep/develop/select and uses last inserted decision for tied timestamps", async () => {
    const kept = await source("keep"), watched = await source("watch"), selected = await source("select"), developed = await source("develop");
    await signal(kept.sourceId,"keep"); await signal(watched.sourceId,"keep"); await signal(watched.sourceId,"watch"); await signal(selected.sourceId,"select"); await signal(developed.sourceId,"ignore"); await signal(developed.sourceId,"develop");
    const context = await buildDistillContext(aiEnv(), PRESETS.BALANCED);
    expect(context.sources.find(s=>s.id===kept.sourceId)?.markedForNextResearch).toBe(true);
    expect(context.sources.find(s=>s.id===watched.sourceId)).toBeUndefined();
    expect(context.sources.find(s=>s.id===selected.sourceId)?.signals).toEqual(["select"]);
    expect(context.recentKeepDevelop).toContain("develop");
  });
  it("only uses active-version basic analysis and falls back to metadata when absent", async () => {
    const s = await source("active"); await signal(s.sourceId,"keep");
    await env.DB.prepare("INSERT INTO source_analysis (id,source_id,version_id,analysis_type,payload_json,created_at) VALUES ('stale-basic',?,NULL,'basic',?,'2099-01-01')").bind(s.sourceId,JSON.stringify({summary:"stale summary",important_fragments:["stale quote"]})).run();
    let context = await buildDistillContext(aiEnv(), PRESETS.BALANCED);
    expect(context.sources.find(x=>x.id===s.sourceId)).toMatchObject({summary:null,fragments:[]});
    await env.DB.prepare("INSERT INTO source_analysis (id,source_id,version_id,analysis_type,payload_json,created_at) VALUES ('active-basic',?,?,'basic',?,'2026-01-01')").bind(s.sourceId,s.activeVersionId,JSON.stringify({summary:"active summary",important_fragments:["active quote"]})).run();
    context = await buildDistillContext(aiEnv(), PRESETS.BALANCED);
    expect(context.sources.find(x=>x.id===s.sourceId)?.summary).toBe("active summary");
  });
  it.each([429,503])("retries provider HTTP %s without misreporting budget exhaustion", async status => {
    const id = `transient-${status}`; await job(id);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("transient",{status})).mockResolvedValueOnce(completion({ok:true})); vi.stubGlobal("fetch",fetcher);
    const options = {researchJobId:id,purpose:"distill",workflowStep:"test",modelId:"test-model",messages:[{role:"user" as const,content:"hello"}]};
    await expect(callOpenAi(aiEnv(),options)).rejects.toThrow(`openai_error_${status}`);
    await expect(callOpenAi(aiEnv(),options)).resolves.toMatchObject({text:'{"ok":true}'});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps permanent provider failures distinct from budget exhaustion", async () => {
    await job("permanent-failure"); const fetcher = vi.fn(async () => new Response("bad request", { status: 400 })); vi.stubGlobal("fetch", fetcher);
    const options = { researchJobId: "permanent-failure", purpose: "distill", messages: [{ role: "user" as const, content: "hello" }] };
    await expect(callOpenAi(aiEnv(), options)).rejects.toThrow("openai_error_400");
    await expect(callOpenAi(aiEnv(), options)).rejects.toThrow("openai_error_400");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("consumes old marks at the next research cutoff and accepts subsequent decisions", async () => {
    const s = await source("cutoff");
    await signal(s.sourceId, "keep", "2098-01-01T00:00:00.000Z");
    await env.DB.prepare("INSERT INTO distill_sessions (id, created_at) VALUES ('cutoff-session', '2098-02-01T00:00:00.000Z')").run();
    expect((await buildDistillContext(aiEnv(), PRESETS.BALANCED)).sources.find(item => item.id === s.sourceId)).toBeUndefined();
    await signal(s.sourceId, "develop", "2098-03-01T00:00:00.000Z");
    expect((await buildDistillContext(aiEnv(), PRESETS.BALANCED)).sources.find(item => item.id === s.sourceId)?.markedForNextResearch).toBe(true);
  });
  it("cleans execution snapshots atomically when a job becomes terminal", async () => {
    await job("snapshot-terminal");
    await env.DB.prepare("UPDATE research_jobs SET input_json = ? WHERE id='snapshot-terminal'").bind(JSON.stringify({sourceId:"source",_execution:{deep:{sourceText:"private text"}}})).run();
    await failResearchJob(env.DB,"snapshot-terminal","test","failure");
    const raw = await env.DB.prepare("SELECT status,input_json FROM research_jobs WHERE id='snapshot-terminal'").first<{status:string,input_json:string}>();
    expect(raw?.status).toBe("FAILED");
    expect(JSON.parse(raw!.input_json)).toEqual({sourceId:"source"});
  });
  it("does not reuse settled responses for changed messages or models", async () => {
    await job("cache-input"); const fetcher = vi.fn().mockResolvedValueOnce(completion({v:1})).mockResolvedValueOnce(completion({v:2})).mockResolvedValueOnce(completion({v:3})); vi.stubGlobal("fetch",fetcher);
    const options = {researchJobId:"cache-input",purpose:"deep_analysis",workflowStep:"chunk",modelId:"test-model",messages:[{role:"user" as const,content:"first"}]};
    await callOpenAi(aiEnv(),options);
    expect((await callOpenAi(aiEnv(),{...options,messages:[{role:"user",content:"second"}]})).text).toBe('{"v":2}');
    expect((await callOpenAi(aiEnv(),{...options,modelId:"test-review"})).text).toBe('{"v":3}');
  });
  it("pins deep version and model inputs across failed final persistence and active-version change", async () => {
    const s = await source("deeporiginal"); await job("deep-retry");
    await env.DB.prepare("UPDATE sources SET quality_status='READY' WHERE id=?").bind(s.sourceId).run();
    const fetcher = vi.fn(async()=>completion(deep)); vi.stubGlobal("fetch",fetcher);
    let fail = true;
    const db = new Proxy(env.DB,{get(target,key){if(key==='prepare') return (sql:string)=>{if(fail && sql.includes('INSERT') && sql.includes('INTO source_analysis')) { fail=false; throw new Error('injected analysis persistence'); } return target.prepare(sql);}; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    await expect(analyzeDeepSource({...aiEnv(),DB:db},s.sourceId,"precision","deep-retry")).rejects.toThrow("injected analysis persistence");
    expect((await getResearchJob(env.DB,"deep-retry"))?.input).not.toHaveProperty("_execution");
    expect((await env.DB.prepare("SELECT json_extract(input_json, '$._execution.deep') AS snapshot FROM research_jobs WHERE id='deep-retry'").first<{snapshot:string}>())?.snapshot).toBeTruthy();
    const v2=await createSource(aiEnv(), {kind:"NOTE",title:"deeporiginal",origin:"manual",canonicalUrl:"https://example.com/deeporiginal", original:"changed".repeat(1500),extractedText:"changed".repeat(1500),inputFormat:"PLAIN_TEXT",textScope:"FULLTEXT",extractionMethod:"MANUAL_TEXT"});
    await env.DB.prepare("UPDATE sources SET quality_status='READY',active_version_id=? WHERE id=?").bind(v2.activeVersionId,s.sourceId).run();
    const result=await analyzeDeepSource({...aiEnv(),MODEL_HIGH:"changed-model"},s.sourceId,"precision","deep-retry");
    expect(result.payload.meta.versionId).toBe(s.activeVersionId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare("SELECT json_extract(input_json, '$._execution') AS snapshot FROM research_jobs WHERE id='deep-retry'").first<{snapshot:string|null}>())?.snapshot).toBeNull();
    expect((await analyzeDeepSource(aiEnv(),s.sourceId,"precision","deep-retry")).analysisId).toBe(result.analysisId);
  });
  it("replays one persisted distill session and children after final budget lookup fails", async () => {
    await job("distill-retry"); let persisted = false, fail = true;
    const db = new Proxy(env.DB,{get(target,key){if(key==='batch') return async (stmts:D1PreparedStatement[])=>{const result=await target.batch(stmts);persisted=true;return result;};if(key==='prepare') return (sql:string)=>{if(persisted&&fail&&sql.includes('SUM(cost_usd)')) {fail=false;throw new Error('injected final budget');}return target.prepare(sql);}; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>completion(String(init?.body).includes('You are Distill,')?distill:{warnings:[],overall:"ok"}));vi.stubGlobal("fetch",fetcher);
    // Only flag persistence after a distill session batch, not AI usage settlement.
    const originalBatch = db.batch.bind(db);
    const proxy = new Proxy(db,{get(target,key){if(key==='batch')return async(stmts:D1PreparedStatement[])=>{const result=await originalBatch(stmts);persisted=Boolean(await env.DB.prepare("SELECT id FROM distill_sessions WHERE output_json=?").bind(JSON.stringify(distill)).first());return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
    await expect(runDistill({...aiEnv(),DB:proxy},PRESETS.BALANCED,{researchJobId:"distill-retry",includeCounter:false})).rejects.toThrow("injected final budget");
    const replay=await runDistill(aiEnv(),PRESETS.BALANCED,{researchJobId:"distill-retry",includeCounter:false});expect(replay.ok).toBe(true);
    const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM distill_sessions WHERE output_json=?").bind(JSON.stringify(distill)).first<{n:number}>();expect(count?.n).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
    if (replay.ok) {
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM reading_queue WHERE distill_session_id=?").bind(replay.sessionId).first<{n:number}>())?.n).toBe(1);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM research_gaps WHERE distill_session_id=?").bind(replay.sessionId).first<{n:number}>())?.n).toBe(1);
      await expect(runDistill({...aiEnv(), MONTHLY_BUDGET_USD:"0.000001"}, PRESETS.BALANCED, {researchJobId:"distill-retry"})).resolves.toMatchObject({ok:true,sessionId:replay.sessionId});
    }
  });
});
