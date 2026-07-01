/**
 * Manual smoke test of the real Google provider. Needs GOOGLE_MAPS_API_KEY
 * (Places API New + Routes + Geocoding enabled).
 *
 *   npm run smoke:google -w @gotrip/backend   # loads ../../.env
 */

import { createGoogleToolProvider } from "../infrastructure/tools/google/googleToolProvider";

async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error("set GOOGLE_MAPS_API_KEY in the repo-root .env");
    process.exit(1);
  }
  const g = createGoogleToolProvider({ apiKey });

  console.log("geocode 'Shinjuku Station, Tokyo' …");
  const here = await g.geocode({ query: "Shinjuku Station, Tokyo" });
  console.log("  →", here);

  const center = here ?? { name: "Tokyo", lat: 35.69, lng: 139.7 };
  console.log("\nsearch 'museums in Tokyo' (4km bias) …");
  const places = await g.searchPlaces({ query: "museums in Tokyo", center, radius: 4000, maxResults: 5 });
  for (const p of places) console.log(`  - ${p.name}  (${p.category}, ${p.rating ?? "?"}★)  ${p.placeId}`);

  const first = places[0];
  if (first) {
    console.log(`\ndetails of ${first.name} …`);
    const d = await g.getPlaceDetails({ placeId: first.placeId });
    console.log("  →", JSON.stringify({ category: d.category, location: d.location, openWindow: d.openWindow, rating: d.rating, priceLevel: d.priceLevel }));

    console.log(`\ntravel Shinjuku → ${first.name} (transit) …`);
    const tt = await g.getTravelTime({ origin: center, destination: d.location, mode: "transit" });
    console.log("  →", tt, "(geometric fallback in Japan — transit API is unlicensed there)");
  }
  console.log("\nok");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
