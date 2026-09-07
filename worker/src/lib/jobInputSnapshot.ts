/** Server-only input snapshots; enqueue and public job mapping strip the reserved _execution field. */
export async function jobInputSnapshot<T>(db: D1Database, jobId: string | undefined, kind: string, create: () => Promise<T>): Promise<T> {
  if (!jobId) return create();
  const path = `$._execution.${kind}`;
  const read = () => db.prepare("SELECT json_extract(input_json, ?) AS snapshot FROM research_jobs WHERE id = ?")
    .bind(path, jobId).first<{ snapshot: string | null }>();
  const existing = await read();
  if (!existing) throw new Error("research_job_not_found");
  if (existing.snapshot) return JSON.parse(existing.snapshot) as T;
  const snapshot = await create();
  await db.prepare("UPDATE research_jobs SET input_json = json_insert(input_json, ?, json(?)) WHERE id = ?")
    .bind(path, JSON.stringify(snapshot), jobId).run();
  const committed = await read();
  if (!committed?.snapshot) throw new Error("research_job_snapshot_failed");
  return JSON.parse(committed.snapshot) as T;
}
