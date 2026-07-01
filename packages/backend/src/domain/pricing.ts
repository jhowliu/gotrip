/**
 * Price estimation — Google Places gives `priceLevel` (0–4, mostly for dining)
 * but no admission/ticket prices, so the budget would be meaningless on real
 * data. These pure heuristics fill the gap: a category default for admission
 * (most attractions are free; museums/observatories/parks-of-note are paid), a
 * small curated override for well-known paid spots, and a priceLevel → per-person
 * meal cost (where priceLevel is actually meaningful). Destination currency.
 */

/** Category → typical admission. Absent = free (parks, temples, landmarks, …). */
const ADMISSION_BY_CATEGORY: Readonly<Record<string, number>> = {
  museum: 300,
  aquarium: 500,
  zoo: 300,
  amusement_park: 800,
  garden: 100,
};

/** Well-known paid spots whose category alone wouldn't price them (substring, lower-cased). */
const ADMISSION_OVERRIDES: ReadonlyArray<readonly [string, number]> = [
  ["taipei 101", 600],
  ["national palace museum", 350],
  ["taipei zoo", 60],
];

export function estimateAdmission(category: string, name = ""): number {
  const lower = name.toLowerCase();
  for (const [key, price] of ADMISSION_OVERRIDES) if (lower.includes(key)) return price;
  return ADMISSION_BY_CATEGORY[category.toLowerCase()] ?? 0;
}

/** priceLevel (0–4, meaningful for dining) → estimated per-person meal cost. */
const MEAL_BY_PRICE_LEVEL: Readonly<Record<number, number>> = { 0: 0, 1: 200, 2: 500, 3: 1000, 4: 2000 };

export function estimateMealCost(priceLevel?: number): number {
  if (priceLevel === undefined) return 300; // unknown → a moderate default
  return MEAL_BY_PRICE_LEVEL[priceLevel] ?? 300;
}
