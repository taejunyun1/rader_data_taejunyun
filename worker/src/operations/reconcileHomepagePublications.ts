import { repairHomepagePublicationLedger } from "../publication/service";

/**
 * Hourly repair is deliberately a thin operation boundary. The service owns
 * the singleton lease, R2 truth checks, and ID/hash proof rules so deferred
 * requests and scheduled runs cannot diverge.
 */
export async function reconcileHomepagePublications(
  env: Pick<Env, "DB" | "PUBLICATIONS">,
): Promise<{ scanned: number; repaired: number; failed: number; busy: boolean }> {
  return repairHomepagePublicationLedger(env);
}
