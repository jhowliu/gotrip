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
    <header className="header">
      <span className="brand">gotrip</span>
      <span className="sub">
        {props.destination} · {props.days} days · {yen(props.totalCost)}
      </span>
      <span className="spacer" />
      <span className={"pill" + (props.chatEnabled ? " on" : "")}>
        {props.chatEnabled ? "chat on" : "chat off (set OPENAI_API_KEY)"}
      </span>
      <button onClick={props.onPlan} disabled={props.busy}>
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
    <div className="banner">
      {hardViolations.map((v, i) => (
        <div key={"h" + i} className="v hard">
          ⛔ {v.code} — {v.message}
        </div>
      ))}
      {softWarnings.map((v, i) => (
        <div key={"s" + i} className="v soft">
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
    return <div className="trans">↓ {item.durationMinutes} min transit</div>;
  }
  if (item.kind === "meal") {
    return (
      <div className="card meal">
        <span className="t">{item.startTime}</span> <span className="nm">{item.name}</span>{" "}
        <span className="meta inline">{item.durationMinutes} min</span>
      </div>
    );
  }
  const cost = item.estimatedCost && item.estimatedCost > 0 ? yen(item.estimatedCost) : "free";
  return (
    <div
      className={"card visit" + (item.pinned ? " pinned" : "")}
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", item.itemId)}
    >
      <div className="cardtop">
        <span className="t">{item.startTime}</span>
        <span className="nm">{item.name}</span>
        {item.pinned ? <span className="badge">★ must</span> : null}
      </div>
      <div className="meta">
        {item.durationMinutes} min · {cost}
      </div>
      <div className="acts">
        <button onClick={() => onOp([{ op: "move", itemId: item.itemId, toDay: dayIndex, atTime: "09:00" }])}>morning</button>
        <button onClick={() => onOp([{ op: "setDuration", itemId: item.itemId, minutes: item.durationMinutes + 30 }])}>+30</button>
        <button onClick={() => onOp([{ op: "setDuration", itemId: item.itemId, minutes: Math.max(15, item.durationMinutes - 30) }])}>−30</button>
        <button onClick={() => onOp([{ op: "pin", itemId: item.itemId }])}>pin</button>
        <button onClick={() => onOp([{ op: "remove", itemId: item.itemId }])}>remove</button>
      </div>
    </div>
  );
}

export function DayColumn({ day, onOp }: { day: Day; onOp: (ops: EditOp[]) => void }): JSX.Element {
  const [over, setOver] = useState(false);
  const visits = day.items.filter((i) => i.kind === "visit").length;
  return (
    <div
      className={"daycol" + (over ? " over" : "")}
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
      <div className="dayhead">
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
    <footer className="footer">
      <form
        className="chatform"
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
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={enabled ? "Move Senso-ji to the morning…" : "chat needs OPENAI_API_KEY on the server"}
          autoComplete="off"
        />
        <button type="submit">Send</button>
      </form>
    </footer>
  );
}
