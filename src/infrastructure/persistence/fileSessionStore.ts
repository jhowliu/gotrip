/**
 * FileSessionStore — one JSON file per session under a directory. Atomic writes
 * (temp file + rename). Implements the TripRepository port. Inspectable on disk,
 * zero infra; graduates to SQLite when top-trips/undo/multi-session need it.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Itinerary } from "../../domain/itinerary";
import type { TripRepository } from "../../application/ports/TripRepository";

export function createFileSessionStore(dir: string): TripRepository {
  const fileFor = (sessionId: string): string => join(dir, `${encodeURIComponent(sessionId)}.json`);

  return {
    async load(sessionId: string): Promise<Itinerary | null> {
      try {
        const raw = await readFile(fileFor(sessionId), "utf8");
        return JSON.parse(raw) as Itinerary;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async save(sessionId: string, itinerary: Itinerary): Promise<void> {
      await mkdir(dir, { recursive: true });
      const file = fileFor(sessionId);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(itinerary, null, 2), "utf8");
      await rename(tmp, file);
    },
  };
}
