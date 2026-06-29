/**
 * Cost estimation — pure summation against the budget. Also exposed as a tool.
 */

export interface CostItem {
  label: string;
  amount: number;
}

export interface CostBreakdown {
  total: number;
  breakdown: CostItem[];
}

export function estimateCost(items: CostItem[]): CostBreakdown {
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  return { total, breakdown: items };
}
