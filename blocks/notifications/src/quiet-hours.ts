/**
 * Quiet-hours evaluation. The window math — including windows that cross midnight — is pure and
 * unit tested, because getting it wrong either wakes users at 3am or silently defers everything.
 * The only non-pure helper is `localMinutes`, which uses Intl to read the wall-clock minute in an
 * IANA timezone (deterministic, so still testable).
 */

export interface QuietWindow {
  /** Minutes since local midnight, inclusive start. */
  startMin: number;
  /** Minutes since local midnight, exclusive end. */
  endMin: number;
}

/** Parse "HH:MM-HH:MM" into a window, or null when empty/malformed. */
export function parseQuietHours(spec: string | null | undefined): QuietWindow | null {
  if (!spec) return null;
  const m = spec.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return null; // zero-length window is "no quiet hours"
  return { startMin, endMin };
}

/** Wall-clock minutes since local midnight for `date` in `timeZone`, via Intl. */
export function localMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Whether `nowMin` falls inside the window. Handles windows that wrap past midnight. */
export function isWithinQuietHours(nowMin: number, w: QuietWindow): boolean {
  return w.startMin <= w.endMin
    ? nowMin >= w.startMin && nowMin < w.endMin
    : nowMin >= w.startMin || nowMin < w.endMin; // crosses midnight
}

/** Minutes from `nowMin` until the window ends (only meaningful when currently inside it). */
export function minutesUntilEnd(nowMin: number, w: QuietWindow): number {
  if (w.startMin <= w.endMin) return w.endMin - nowMin;
  // Crosses midnight: if we're in the pre-midnight part, add the wrap.
  return nowMin >= w.startMin ? 1440 - nowMin + w.endMin : w.endMin - nowMin;
}

/**
 * The instant a notification received `now` should be released, if `now` is inside quiet hours in
 * `timeZone`; null when it is not quiet (send immediately).
 */
export function releaseAfterQuietHours(now: Date, timeZone: string, w: QuietWindow): Date | null {
  const nowMin = localMinutes(now, timeZone);
  if (!isWithinQuietHours(nowMin, w)) return null;
  return new Date(now.getTime() + minutesUntilEnd(nowMin, w) * 60_000);
}
