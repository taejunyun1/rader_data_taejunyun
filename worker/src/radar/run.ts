import type { RadarPeriod } from "@radar/shared";
import { computeStats, saveSnapshot, saveSnapshotSynthesis, windowFor } from "./snapshot";
import { synthesizeRadar } from "./synthesize";

export async function runRadarSynthesis(env: Env, period: RadarPeriod, researchJobId?: string): Promise<{ snapshotId: string; synthesis: unknown }> {
  const result = await synthesizeRadar(env, period, researchJobId);
  const { start, end } = windowFor(period);
  const stats = await computeStats(env.DB, start.toISOString(), end.toISOString());
  const snapshotId = await saveSnapshot(env.DB, period, stats, start.toISOString(), end.toISOString());
  await saveSnapshotSynthesis(env.DB, snapshotId, result);
  return { snapshotId, synthesis: result };
}
