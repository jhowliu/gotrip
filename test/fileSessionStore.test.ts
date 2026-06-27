import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Itinerary } from "../src/domain/itinerary";
import { createFileSessionStore } from "../src/infrastructure/persistence/fileSessionStore";

function sampleItinerary(): Itinerary {
  return {
    request: { days: 1, destination: "Tokyo", accommodation: { name: "Hotel", lat: 35.69, lng: 139.7 } },
    days: [
      {
        dayIndex: 1,
        items: [
          { itemId: "d1-v1", kind: "visit", placeId: "p_x", name: "X", startTime: "09:00", durationMinutes: 60, estimatedCost: 500 },
        ],
      },
    ],
    totalCost: 500,
  };
}

describe("FileSessionStore", () => {
  it("saves and reloads an itinerary identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gotrip-sessions-"));
    const store = createFileSessionStore(dir);
    const itinerary = sampleItinerary();

    await store.save("session-1", itinerary);
    const loaded = await store.load("session-1");

    expect(loaded).toEqual(itinerary);
  });

  it("returns null for an unknown session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gotrip-sessions-"));
    const store = createFileSessionStore(dir);
    expect(await store.load("does-not-exist")).toBeNull();
  });
});
