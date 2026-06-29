/**
 * Zod schema for the structured edit operations — the single tool-layer guard
 * shared by the warm-edit agent tool and the HTTP edit endpoint. Infers to the
 * domain `EditOp` union.
 */

import { z } from "zod";

export const editOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), itemId: z.string(), toDay: z.number().int().positive(), atTime: z.string().optional() }),
  z.object({ op: z.literal("add"), placeId: z.string(), day: z.number().int().positive() }),
  z.object({ op: z.literal("remove"), itemId: z.string() }),
  z.object({ op: z.literal("setDuration"), itemId: z.string(), minutes: z.number().int().positive() }),
  z.object({ op: z.literal("pin"), itemId: z.string() }),
]);

export const editOpsSchema = z.array(editOpSchema).min(1);

export type EditOpInput = z.infer<typeof editOpSchema>;
