/**
 * Warm-start editing use case: load a saved session, apply edits, persist if
 * changed. Returns null when there is no saved session — the caller cold-starts
 * (plans from scratch) instead. This is the cold/warm routing seam; the
 * conversational agent (Phase 3 / #7) drives edits through here.
 */

import { applyEdits, type ApplyEditsDeps, type ApplyEditsResult, type EditOp } from "../../domain/applyEdits";
import type { TripRepository } from "../ports/TripRepository";

export async function editSession(
  repo: TripRepository,
  sessionId: string,
  ops: EditOp[],
  deps: ApplyEditsDeps,
): Promise<ApplyEditsResult | null> {
  const itinerary = await repo.load(sessionId);
  if (!itinerary) return null; // no saved itinerary → cold start
  const result = applyEdits(itinerary, ops, deps);
  if (result.changed) await repo.save(sessionId, result.itinerary);
  return result;
}
