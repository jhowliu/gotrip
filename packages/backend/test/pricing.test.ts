import { describe, expect, it } from "vitest";
import { estimateAdmission, estimateMealCost } from "../src/domain/pricing";

describe("pricing", () => {
  it("estimates admission by category, with named overrides winning", () => {
    expect(estimateAdmission("landmark", "Taipei 101")).toBe(600); // override beats the category default (0)
    expect(estimateAdmission("museum", "Some Museum")).toBe(300);
    expect(estimateAdmission("park", "Da'an Forest Park")).toBe(0); // free
    expect(estimateAdmission("temple")).toBe(0);
    expect(estimateAdmission("garden", "Botanical Garden")).toBe(100);
  });

  it("estimates per-person meal cost from price level", () => {
    expect(estimateMealCost(0)).toBe(0);
    expect(estimateMealCost(1)).toBe(200);
    expect(estimateMealCost(3)).toBe(1000);
    expect(estimateMealCost(undefined)).toBe(300);
  });
});
