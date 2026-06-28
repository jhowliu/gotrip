import { useEffect, useState } from "react";
import { applyOps, getConfig, loadSession, planTrip, sendChat, type EditOp, type Itinerary, type Validation } from "./api";
import { Banner, ChatBar, DayColumn, Header } from "./components";

export default function App(): JSX.Element {
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const flash = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3200);
  };

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      setChatEnabled(Boolean(cfg.data.chatEnabled));
      const s = await loadSession();
      if (s.ok) {
        setItinerary(s.data.itinerary);
        setValidation(s.data.validation);
      }
    })();
  }, []);

  const plan = async (): Promise<void> => {
    setBusy(true);
    flash("Planning…");
    const r = await planTrip();
    setBusy(false);
    if (!r.ok) return flash(r.data.error ?? "plan failed");
    setItinerary(r.data.itinerary);
    setValidation(r.data.validation);
    flash("Planned");
  };

  const onOp = async (ops: EditOp[]): Promise<void> => {
    const r = await applyOps(ops);
    if (!r.ok) return flash(r.data.error ?? "edit rejected");
    setItinerary(r.data.itinerary);
    setValidation(r.data.validation);
    if (r.data.errors && r.data.errors.length > 0) flash(r.data.errors[0]!);
    else if (r.data.changed === false) flash("no change");
  };

  const onChat = async (instruction: string): Promise<void> => {
    if (!chatEnabled) return flash("chat needs OPENAI_API_KEY on the server");
    setBusy(true);
    flash("Thinking…");
    const r = await sendChat(instruction);
    setBusy(false);
    if (!r.ok) return flash(r.data.error ?? "chat failed");
    setItinerary(r.data.itinerary);
    setValidation(r.data.validation);
    if (r.data.finalized) flash("Applied");
    else {
      const hard = r.data.validation.hardViolations[0];
      flash("Conflict — not applied. " + (hard ? hard.message : "see report"));
    }
  };

  return (
    <>
      <Header
        destination={itinerary?.request.destination ?? "—"}
        days={itinerary?.days.length ?? 0}
        totalCost={itinerary?.totalCost ?? 0}
        chatEnabled={chatEnabled}
        busy={busy}
        onPlan={plan}
      />
      <main className="main">
        <Banner validation={validation} />
        {itinerary ? (
          <div className="board">
            {itinerary.days.map((d) => (
              <DayColumn key={d.dayIndex} day={d} onOp={onOp} />
            ))}
          </div>
        ) : (
          <div className="empty">No itinerary yet — click “Plan / replan”.</div>
        )}
      </main>
      <ChatBar enabled={chatEnabled} onSend={onChat} />
      <div className={"toast" + (toast ? " show" : "")}>{toast}</div>
    </>
  );
}
