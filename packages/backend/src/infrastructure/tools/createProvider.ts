/**
 * Provider selection (M4) — Google when GOOGLE_MAPS_API_KEY is set (wrapped in
 * the cache), otherwise the mock fixtures. The one place the app decides which
 * real-data source backs the ToolProvider port; everything inward is unchanged.
 */

import type { ToolProvider } from "../../application/ports/ToolProvider";
import { createGoogleToolProvider } from "./google/googleToolProvider";
import { createMockToolProvider } from "./mock/mockToolProvider";
import { withCache } from "./cache";
import { TOKYO_PLACES } from "./mock/fixtures";

export interface SelectedProvider {
  provider: ToolProvider;
  source: "google" | "mock";
}

export function createProvider(): SelectedProvider {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (apiKey) return { provider: withCache(createGoogleToolProvider({ apiKey })), source: "google" };
  return { provider: createMockToolProvider(TOKYO_PLACES), source: "mock" };
}
