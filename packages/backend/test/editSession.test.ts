import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyEditsDeps } from "../src/domain/applyEdits";
import type { Itinerary, TripRequest } from "../src/domain/itinerary";
import { editSession } from "../src/application/editing/editSession";
import { scheduleItinerary } from "../src/domain/schedule";
import { createFileSessionStore } from "../src/infrastructure/persistence/fileSessionStore";
import { TOKYO_ACCOMMODATION, TOKYO_PLACES } from "../src/infrastructure/tools/mock/fixtures";

function setup(): { itinerary: Itinerary; deps: ApplyEditsDeps } {
  const details = new Map(TOKYO_PLACES.map((p) => [p.placeId, p]));
  const request: TripRequest = { days: 2, destination: "Tokyo", accommodation: TOKYO_ACCOMMODATION };
  const legMinutes = (): number => 15;
  const itinerary = scheduleItinerary({
    request,
    assignments: [
      { dayIndex: 1, placeIds: ["p_teamlab", "p_meiji"] },
      { dayIndex: 2, placeIds: ["p_sensoji", "p_ueno"] },
    ],
    details,
    legMinutes,
  });
  return { itinerary, deps: { details, legMinutes } };
}

describe("editSession (warm-start routing)", () => {
  it("loads, edits, and persists a saved session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gotrip-edit-"));
    const store = createFileSessionStore(dir);
    const { itinerary, deps } = setup();
    await store.save("s1", itinerary);

    const visit = itinerary.days[0]!.items.find((i) => i.kind === "visit")!;
    const result = await editSession(store, "s1", [{ op: "setDuration", itemId: visit.itemId, minutes: 200 }], deps);

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);

    const reloaded = await store.load("s1");
    const persisted = reloaded!.days[0]!.items.find((i) => i.placeId === visit.placeId)!;
    expect(persisted.durationMinutes).toBe(200);
  });

  it("returns null when there is no saved session (cold start)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gotrip-edit-"));
    const store = createFileSessionStore(dir);
    const { deps } = setup();
    expect(await editSession(store, "missing", [], deps)).toBeNull();
  });
});
