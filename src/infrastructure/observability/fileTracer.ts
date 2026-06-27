/**
 * File tracer — writes runAgent trace events as NDJSON (one JSON object per line,
 * greppable/parseable) and optionally echoes a compact human-readable line to
 * stderr. Implements the application's `Tracer` port.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { TraceEvent, Tracer } from "../../application/agent/trace";

export interface FileTracerOptions {
  /** Also print a compact human line to stderr. */
  console?: boolean;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "";
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function humanLine(event: TraceEvent): string | null {
  switch (event.type) {
    case "iteration":
      return `\n— iteration ${event.iteration} —`;
    case "tool_call":
      return `  → ${event.name}(${preview(event.input)})`;
    case "tool_result":
      return `  ← ${event.name} ${event.isError ? "ERROR" : "ok"}${event.final ? " [final]" : ""}: ${preview(event.output)}`;
    case "model_message":
      return `  · model: ${event.text}`;
    case "finish":
      return `= ${event.status} after ${event.iterations} iteration(s)`;
    default:
      return null;
  }
}

export function createFileTracer(filePath: string, options: FileTracerOptions = {}): Tracer {
  mkdirSync(dirname(filePath), { recursive: true });
  return (event: TraceEvent) => {
    const record = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(filePath, `${record}\n`);
    if (options.console) {
      const line = humanLine(event);
      if (line) process.stderr.write(`${line}\n`);
    }
  };
}
