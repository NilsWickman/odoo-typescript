/**
 * Where a request's time goes, with SQL_LOG=1 only (docs/accept/C2f.md): the SQL_LOG line of src/http/dispatch.ts
 * gets the request's phases. Nothing here changes what a request does; without SQL_LOG no Phases object exists.
 *
 * On the deployed Worker the clocks (Date.now, performance.now) advance only at I/O: a phase that only computes reads
 * 0 ms, and its CPU time shows in the next phase that waits for I/O. The phases still add up to the request's time to
 * its response (`resp=`), and the event's `cpuTime` is the whole request's CPU.
 */

/** The phases a request passes through in order; time counts to the current one until the next starts. */
export const PHASES = ["sess", "setup", "auth", "pre", "disp", "post", "commit", "fin"] as const;
export type PhaseName = typeof PHASES[number];

/** Waits inside the phases (they overlap the phases and each other), summed per name. */
export type WaitName = "cw" | "regt" | "regwait" | "save" | "fs";

/** Requests of this isolate: how many it has begun, and those in flight. */
let begun = 0;
const inFlight = new Set<Phases>();

export class Phases {
  /** Date.now() at the handler's start: the log line's timestamp minus `at=` minus the event's is the time before it. */
  private readonly start = Date.now();
  private readonly t0 = performance.now();
  private current: PhaseName = "sess";
  private since = this.t0;
  private readonly spent = new Map<PhaseName, number>();
  private readonly waits = new Map<WaitName, number>();
  /** The nth request this isolate began (1: the isolate's first). */
  readonly nth: number;
  /** Other requests of the isolate in flight when this one began, and the most at once while it ran. */
  readonly othersAtStart: number;
  othersMax: number;
  /** ms from the start to the response handed back, and from then to the end of all `waitUntil` work. */
  respMs: number | null = null;
  /** The SQL_LOG summaries of the cursors the request closed (one, or more after a retry or a fallback). */
  readonly sqlLines: string[] = [];
  /** The request's `waitUntil` promises, waited for before the line is logged. */
  private readonly pending: Promise<unknown>[] = [];
  /** Database round trips: time with at least one statement unanswered, over all the request's cursors. */
  sqlWallMs = 0;
  private sqlOpen = 0;
  private sqlSince = 0;

  constructor() {
    this.nth = ++begun;
    this.othersAtStart = inFlight.size;
    this.othersMax = inFlight.size;
    for (const other of inFlight) other.othersMax = Math.max(other.othersMax, inFlight.size);
    inFlight.add(this);
  }

  /** From now on, time counts to `name`. */
  enter(name: PhaseName): void {
    const now = performance.now();
    this.spent.set(this.current, (this.spent.get(this.current) ?? 0) + (now - this.since));
    this.current = name;
    this.since = now;
  }

  /** Adds `ms` to a wait. */
  add(name: WaitName, ms: number): void {
    this.waits.set(name, (this.waits.get(name) ?? 0) + ms);
  }

  /** `p`, with the time until it settles added to the wait `name`. */
  time<T>(name: WaitName, p: Promise<T>): Promise<T> {
    const t = performance.now();
    const done = (): void => this.add(name, performance.now() - t);
    return p.then((v) => { done(); return v; }, (e: unknown) => { done(); throw e; });
  }

  /** A statement was sent (`sqlBegin`) or answered (`sqlEnd`): `sqlWallMs` counts the time any is unanswered. */
  sqlBegin(): void {
    if (this.sqlOpen++ === 0) this.sqlSince = performance.now();
  }

  sqlEnd(): void {
    if (--this.sqlOpen === 0) this.sqlWallMs += performance.now() - this.sqlSince;
  }

  /** The ExecutionContext's waitUntil, with the promises kept so that the line can wait for them. */
  track(exec: { waitUntil(p: Promise<unknown>): void }): { waitUntil(p: Promise<unknown>): void } {
    return { waitUntil: (p) => { this.pending.push(p); exec.waitUntil(p); } };
  }

  /** The response is handed back now. */
  responded(): void {
    this.enter("fin");
    this.respMs = performance.now() - this.t0;
    inFlight.delete(this);
  }

  /** Resolves when every `waitUntil` promise has settled, also those added while waiting. */
  async settled(): Promise<void> {
    for (let i = 0; i < this.pending.length;) {
      const upto = this.pending.length;
      await Promise.allSettled(this.pending.slice(i, upto));
      i = upto;
    }
  }

  /**
   * The fields appended to the SQL_LOG line: `ph=` the phases in order (ms, until the response), `resp=` ms to the
   * response, `wu=` ms after it until the waitUntil work ended, `at=` ms from the start to this line, `sqlw=` ms with
   * a statement unanswered, the waits, and the isolate's `iso=` (nth request) and `conc=` (others at start/most).
   */
  fields(): string {
    const now = performance.now();
    const resp = this.respMs ?? now - this.t0;
    if (this.respMs === null) this.enter("fin");
    const ph = PHASES.map((p) => `${p}:${Math.round(this.spent.get(p) ?? 0)}`).join(",");
    const waits = (["cw", "regt", "regwait", "save", "fs"] as const).map((w) => ` ${w}=${Math.round(this.waits.get(w) ?? 0)}`).join("");
    return `ph=${ph} resp=${Math.round(resp)} wu=${Math.round(now - this.t0 - resp)} at=${Date.now() - this.start} sqlw=${Math.round(this.sqlWallMs)}${waits} iso=${this.nth} conc=${this.othersAtStart}/${this.othersMax}`;
  }

  /** Ends the request (if `responded` was not called) and drops it from the isolate's requests in flight. */
  done(): void {
    inFlight.delete(this);
  }
}

/** Whether SQL_LOG=1 asks for the phases. */
export function phasesWanted(env: object): boolean {
  return Reflect.get(env, "SQL_LOG") === "1";
}
