import { useState } from "react";
import type { Day, EditOp, Item, Validation } from "./api";

const yen = (n: number): string => "¥" + n.toLocaleString();

export function Header(props: {
  destination: string;
  days: number;
  totalCost: number;
  chatEnabled: boolean;
  busy: boolean;
  onPlan: () => void;
}): JSX.Element {
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

export function ItemCard({
  item,
  dayIndex,
  onOp,
}: {
  item: Item;
  dayIndex: number;
  onOp: (ops: EditOp[]) => void;
}): JSX.Element {
  if (item.kind === "transit") {
    return <div className="py-[3px] pr-1 pl-2 text-xs text-mut">↓ {item.durationMinutes} min transit</div>;
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
      {day.items.map((item) => (
        <ItemCard key={item.itemId} item={item} dayIndex={day.dayIndex} onOp={onOp} />
      ))}
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
