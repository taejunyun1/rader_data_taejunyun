import { PRESETS, type RadarParams } from "@radar/shared";

export const PARAMS_KEY = "radar_params_v1";

export async function loadParams(db: D1Database): Promise<RadarParams> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(PARAMS_KEY).first<{ value: string }>();
  if (row) {
    try {
      const p = JSON.parse(row.value) as RadarParams;
      return { ...PRESETS.BALANCED, ...p };
    } catch {
      /* fallthrough */
    }
  }
  return PRESETS.BALANCED;
}
