/**
 * API client — the JSON contract with @gotrip/backend. Types mirror the
 * Itinerary/Validation/EditOp shapes the API returns; the web app stays
 * decoupled from the backend package (talks HTTP only).
 */

export type ItemKind = "visit" | "transit" | "meal";

export interface Item {
  itemId: string;
  kind: ItemKind;
  placeId?: string;
  name: string;
  startTime: string;
  durationMinutes: number;
  pinned?: boolean;
  estimatedCost?: number;
}

export interface Day {
  dayIndex: number;
  items: Item[];
}

export interface Itinerary {
  request: { destination: string; days: number; [key: string]: unknown };
  days: Day[];
  totalCost?: number;
}

export interface Violation {
  code: string;
  message: string;
}

export interface Validation {
  hardViolations: Violation[];
  softWarnings: Violation[];
}

export type EditOp =
  | { op: "move"; itemId: string; toDay: number; atTime?: string }
  | { op: "add"; placeId: string; day: number }
  | { op: "remove"; itemId: string }
  | { op: "setDuration"; itemId: string; minutes: number }
  | { op: "pin"; itemId: string };

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

const SID = "demo";

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  return call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export interface SessionPayload {
  itinerary: Itinerary;
  validation: Validation;
  status?: string;
  finalized?: boolean;
  changed?: boolean;
  errors?: string[];
  error?: string;
}

export const getConfig = (): Promise<ApiResult<{ chatEnabled: boolean }>> => call("/api/config");

export const loadSession = (): Promise<ApiResult<SessionPayload>> => call(`/api/sessions/${SID}`);

export const planTrip = (): Promise<ApiResult<SessionPayload>> =>
  postJson(`/api/sessions/${SID}/plan`, {
    days: 2,
    destination: "Taipei",
    accommodation: { name: "Taipei Main Station Hotel", lat: 25.0478, lng: 121.517 },
    mustVisit: [{ name: "Taipei 101" }],
    pace: "relaxed",
  });

export const applyOps = (operations: EditOp[]): Promise<ApiResult<SessionPayload>> =>
  postJson(`/api/sessions/${SID}/ops`, { operations });

export const sendChat = (instruction: string): Promise<ApiResult<SessionPayload>> =>
  postJson(`/api/sessions/${SID}/chat`, { instruction });
