import { useState } from "react";
import { getRoute, type Day, type EditOp, type Item, type TransitRoute, type Validation } from "./api";

const yen = (n: number): string => "¥" + n.toLocaleString();

export function Header(props: {
  destination: string;
  days: number;
  totalCost: number;
  chatEnabled: boolean;
  provider: string;
  busy: boolean;
  onPlan: () => void;
}): JSX.Element {
  const live = props.provider === "google";
  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-white px-5 py-3.5">
      <span className="text-base font-semibold">gotrip</span>
      <span className="text-[13px] text-mut">
        {props.destination} · {props.days} days · {yen(props.totalCost)}
      </span>
      <span className="flex-1" />
      <span
        className={
          "rounded-full border px-2.5 py-[3px] text-xs " +
          (live ? "border-okline bg-okbg text-okfg" : "border-line text-mut")
        }
        title={live ? "real Google data" : "static mock fixtures — run serve:env with GOOGLE_MAPS_API_KEY for live data"}
      >
        data: {props.provider || "?"}
      </span>
      <span
        className={
          "rounded-full border px-2.5 py-[3px] text-xs " +
          (props.chatEnabled ? "border-okline bg-okbg text-okfg" : "border-line text-mut")
        }
      >
        {props.chatEnabled ? "chat on" : "chat off (set OPENAI_API_KEY)"}
      </span>
      <button className="btn" onClick={props.onPlan} disabled={props.busy}>
        Plan / replan
      </button>
    </header>
  );
}

export interface TripFormState {
  destination: string;
  days: number;
  accommodation: string;
  mustVisit: string; // comma-separated names
  budgetMax: string;
  pace: "relaxed" | "packed";
}

export function TripForm({
  value,
  onChange,
  onSubmit,
  busy,
}: {
  value: TripFormState;
  onChange: (v: TripFormState) => void;
  onSubmit: () => void;
  busy: boolean;
}): JSX.Element {
  const set = <K extends keyof TripFormState>(k: K, v: TripFormState[K]): void => onChange({ ...value, [k]: v });
  const field = "rounded-lg border border-line bg-white px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent";
  const label = "flex flex-col gap-1 text-xs text-mut";
  return (
    <form
      className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-end gap-3 rounded-xl border border-line bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className={label}>
        destination
        <input className={field} value={value.destination} onChange={(e) => set("destination", e.target.value)} placeholder="Taipei" />
      </label>
      <label className={label}>
        days
        <input type="number" min={1} max={14} className={field} value={value.days} onChange={(e) => set("days", Number(e.target.value))} />
      </label>
      <label className={label}>
        accommodation
        <input className={field} value={value.accommodation} onChange={(e) => set("accommodation", e.target.value)} placeholder="Taipei Main Station" />
      </label>
      <label className={label}>
        must-visit (comma-separated)
        <input className={field} value={value.mustVisit} onChange={(e) => set("mustVisit", e.target.value)} placeholder="Taipei 101, Longshan Temple" />
      </label>
      <label className={label}>
        budget / day (max)
        <input type="number" min={0} className={field} value={value.budgetMax} onChange={(e) => set("budgetMax", e.target.value)} placeholder="optional" />
      </label>
      <label className={label}>
        pace
        <select className={field} value={value.pace} onChange={(e) => set("pace", e.target.value as "relaxed" | "packed")}>
          <option value="relaxed">relaxed</option>
          <option value="packed">packed</option>
        </select>
      </label>
      <button type="submit" className="btn" disabled={busy}>
        {busy ? "planning…" : "Plan trip"}
      </button>
    </form>
  );
}

export function Banner({ validation }: { validation: Validation | null }): JSX.Element | null {
  if (!validation) return null;
  const { hardViolations, softWarnings } = validation;
  if (hardViolations.length === 0 && softWarnings.length === 0) return null;
  return (
    <div className="mb-2">
      {hardViolations.map((v, i) => (
        <div key={"h" + i} className="mb-2 rounded-lg bg-dangerbg px-3 py-2 text-[13px] text-danger">
          ⛔ {v.code} — {v.message}
        </div>
      ))}
      {softWarnings.map((v, i) => (
        <div key={"s" + i} className="mb-2 rounded-lg bg-warnbg px-3 py-2 text-[13px] text-warn">
          ⚠ {v.code} — {v.message}
        </div>
      ))}
    </div>
  );
}

function TransitRow({ item, from, to }: { item: Item; from?: string; to?: string }): JSX.Element {
  const [route, setRoute] = useState<TransitRoute | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    if (!from || !to) return;
    setLoading(true);
    const r = await getRoute(from, to);
    setLoading(false);
    setRoute(r.data.route ?? null);
  };

  return (
    <div className="py-[3px] pr-1 pl-2 text-xs text-mut">
      <span>↓ {item.durationMinutes} min transit</span>
      {from && to ? (
        <button
          className="ml-2 rounded border border-line px-1.5 py-px text-[11px] hover:bg-paper"
          onClick={load}
          disabled={loading || route !== undefined}
        >
          {loading ? "…" : "route"}
        </button>
      ) : null}
      {route !== undefined ? (
        <div className="mt-0.5 text-[11px] text-accent">{route ? `🚇 ${route.summary} · ${route.durationMinutes} min` : "no transit detail (mock / region not covered)"}</div>
      ) : null}
    </div>
  );
}

export function ItemCard({
  item,
  dayIndex,
  onOp,
  from,
  to,
}: {
  item: Item;
  dayIndex: number;
  onOp: (ops: EditOp[]) => void;
  from?: string;
  to?: string;
}): JSX.Element {
  if (item.kind === "transit") {
    return <TransitRow item={item} from={from} to={to} />;
  }
  if (item.kind === "meal") {
    return (
      <div className="my-1.5 rounded-[10px] border border-warnline bg-warnbg px-2.5 py-2">
        <span className="text-xs tabular-nums text-mut">{item.startTime}</span>{" "}
        <span className="text-sm font-medium">{item.name}</span>{" "}
        <span className="ml-1.5 text-xs text-mut">{item.durationMinutes} min</span>
      </div>
    );
  }
  const cost = item.estimatedCost && item.estimatedCost > 0 ? yen(item.estimatedCost) : "free";
  return (
    <div
      className={
        "my-1.5 cursor-grab rounded-[10px] bg-white px-2.5 py-2 active:cursor-grabbing " +
        (item.pinned ? "border-2 border-accent" : "border border-line")
      }
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", item.itemId)}
    >
      <div className="flex items-center gap-[7px]">
        <span className="text-xs tabular-nums text-mut">{item.startTime}</span>
        <span className="text-sm font-medium">{item.name}</span>
        {item.pinned ? (
          <span className="ml-auto rounded-md bg-accentbg px-[7px] py-px text-[11px] text-accent">★ must</span>
        ) : null}
      </div>
      <div className="mt-0.5 text-xs text-mut">
        {item.durationMinutes} min · {cost}
      </div>
      <div className="mt-[7px] flex flex-wrap gap-[5px]">
        <button className="btn btn-xs" onClick={() => onOp([{ op: "move", itemId: item.itemId, toDay: dayIndex, atTime: "09:00" }])}>
          morning
        </button>
        <button className="btn btn-xs" onClick={() => onOp([{ op: "setDuration", itemId: item.itemId, minutes: item.durationMinutes + 30 }])}>
          +30
        </button>
        <button className="btn btn-xs" onClick={() => onOp([{ op: "setDuration", itemId: item.itemId, minutes: Math.max(15, item.durationMinutes - 30) }])}>
          −30
        </button>
        <button className="btn btn-xs" onClick={() => onOp([{ op: "pin", itemId: item.itemId }])}>
          pin
        </button>
        <button className="btn btn-xs" onClick={() => onOp([{ op: "remove", itemId: item.itemId }])}>
          remove
        </button>
      </div>
    </div>
  );
}

export function DayColumn({ day, onOp }: { day: Day; onOp: (ops: EditOp[]) => void }): JSX.Element {
  const [over, setOver] = useState(false);
  const visits = day.items.filter((i) => i.kind === "visit").length;
  return (
    <div
      className={
        "min-h-[120px] rounded-xl border p-3 pb-4 " + (over ? "border-accent bg-accentbg" : "border-line bg-white")
      }
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const itemId = e.dataTransfer.getData("text/plain");
        if (itemId) onOp([{ op: "move", itemId, toDay: day.dayIndex }]);
      }}
    >
      <div className="mb-2 text-sm font-semibold">
        Day {day.dayIndex} · {visits} visits
      </div>
      {day.items.map((item, idx) => {
        const from = item.kind === "transit" ? [...day.items.slice(0, idx)].reverse().find((i) => i.kind === "visit")?.placeId : undefined;
        const to = item.kind === "transit" ? day.items.slice(idx + 1).find((i) => i.kind === "visit")?.placeId : undefined;
        return <ItemCard key={item.itemId} item={item} dayIndex={day.dayIndex} onOp={onOp} from={from} to={to} />;
      })}
    </div>
  );
}

export function ChatBar({ enabled, onSend }: { enabled: boolean; onSend: (instruction: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <footer className="fixed inset-x-0 bottom-0 border-t border-line bg-white px-5 py-3">
      <form
        className="mx-auto flex max-w-[920px] gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = text.trim();
          if (v) {
            onSend(v);
            setText("");
          }
        }}
      >
        <input
          className="flex-1 rounded-lg border border-line bg-paper px-3 py-[9px] text-sm text-ink outline-none focus:border-accent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={enabled ? "Move Senso-ji to the morning…" : "chat needs OPENAI_API_KEY on the server"}
          autoComplete="off"
        />
        <button type="submit" className="btn">
          Send
        </button>
      </form>
    </footer>
  );
}
