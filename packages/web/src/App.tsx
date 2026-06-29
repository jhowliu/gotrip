import { useEffect, useState } from "react";
import { applyOps, getConfig, loadSession, planTrip, sendChat, type EditOp, type Itinerary, type PlanRequest, type Validation } from "./api";
import { Banner, ChatBar, DayColumn, Header, TripForm, type TripFormState } from "./components";

export default function App(): JSX.Element {
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState<TripFormState>({
    destination: "Taipei",
    days: 2,
    accommodation: "Taipei Main Station Hotel",
    mustVisit: "Taipei 101",
    budgetMax: "",
    pace: "relaxed",
  });

  const flash = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(""), 3200);
  };

  useEffect(() => {
    void (async () => {
      const cfg = await getConfig();
      setChatEnabled(Boolean(cfg.data.chatEnabled));
      setProvider(cfg.data.provider ?? "");
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
    const request: PlanRequest = {
      destination: form.destination.trim() || "Taipei",
      days: Math.max(1, Math.min(14, Math.round(Number(form.days) || 2))),
      accommodation: { name: form.accommodation.trim() || form.destination.trim() || "Taipei" },
      mustVisit: form.mustVisit
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name })),
      ...(form.budgetMax.trim() ? { budget: { max: Number(form.budgetMax) } } : {}),
      pace: form.pace,
    };
    const r = await planTrip(request);
    setBusy(false);
    if (!r.ok) return flash(r.data.error ?? "plan failed");
    setItinerary(r.data.itinerary);
    setValidation(r.data.validation);
    const errs = r.data.resolveErrors;
    flash(errs && errs.length > 0 ? `Planned · ${errs[0]}` : "Planned");
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
        provider={provider}
        busy={busy}
        onPlan={plan}
      />
      <main className="mx-auto max-w-[920px] px-5 pb-[120px] pt-[18px]">
        <TripForm value={form} onChange={setForm} onSubmit={plan} busy={busy} />
        <Banner validation={validation} />
        {itinerary ? (
          <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
            {itinerary.days.map((d) => (
              <DayColumn key={d.dayIndex} day={d} onOp={onOp} />
            ))}
          </div>
        ) : (
          <div className="p-8 text-center text-mut">No itinerary yet — click “Plan / replan”.</div>
        )}
      </main>
      <ChatBar enabled={chatEnabled} onSend={onChat} />
      <div
        className={
          "pointer-events-none fixed bottom-[74px] left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg bg-ink px-4 py-[9px] text-[13px] text-white transition-opacity " +
          (toast ? "opacity-100" : "opacity-0")
        }
      >
        {toast}
      </div>
    </>
  );
}
