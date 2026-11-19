// Workdays (Mon–Fri) for the server's slots and the web view's buttons. Dependency-free.

/** Mon–Fri. */
export const isWorkday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

/** A day to skip besides weekends (a day off on the calendar). Given that day at the slot's time. */
export type OffDay = (d: Date) => boolean;

/** The next workday after `now`'s day, at hours:minutes local: tomorrow, or Monday from Friday or the weekend.
 *  `off` skips more days (out of office); after a year of days off it gives up and returns the next plain workday. */
export function nextWorkdayAt(hours: number, minutes = 0, now = new Date(), off?: OffDay) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(hours, minutes, 0, 0);
  const skipWeekend = () => { while (!isWorkday(d)) d.setDate(d.getDate() + 1); };
  skipWeekend();
  if (!off) return d;
  const plain = new Date(d);
  for (let i = 0; i < 262; i++) { // ~a year of workdays
    if (!off(d)) return d;
    d.setDate(d.getDate() + 1);
    skipWeekend();
  }
  return off(d) ? plain : d;
}

/** "Tomorrow" when `at` is the day after `now`, else its short weekday ("Mon"). */
export function dayWord(at: Date, now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return at.toDateString() === tomorrow.toDateString() ? "Tomorrow" : at.toLocaleDateString("en-GB", { weekday: "short" });
}

/** The next work morning (09:30) and its label: "Tomorrow 09:30" Sun–Thu, "Mon 09:30" on Friday and Saturday. */
export function nextWorkMorningSlot(now = new Date(), off?: OffDay) {
  const at = nextWorkdayAt(9, 30, now, off);
  return { at, label: `${dayWord(at, now)} 09:30` };
}

/** Next Monday 09:30, a week out on a Monday. */
export function nextMonday(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + (((8 - now.getDay()) % 7) || 7));
  d.setHours(9, 30, 0, 0);
  return d;
}

/** Wrap up's "Carry": the next work morning. Friday's carry lands Monday, not Saturday; `off` skips days off too
 *  (11-12 22:43: three carries landed on an all-day OOO Friday). More than six days out the label gets the date. */
export function carrySlot(now = new Date(), off?: OffDay) {
  const { at, label } = nextWorkMorningSlot(now, off);
  const far = at.getTime() - now.getTime() > 6 * 86_400_000;
  const day = far ? `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} 09:30` : label;
  return { at, label: `${day.toLowerCase()} (carried)` };
}

/** The item drawer's morning buttons: the next work morning, then next Monday unless that is the same slot. */
export function morningButtons(now = new Date()): Array<{ label: string; at: Date }> {
  const { at, label } = nextWorkMorningSlot(now);
  const mon = nextMonday(now);
  return [{ label: label.toLowerCase(), at }, ...(mon.getTime() === at.getTime() ? [] : [{ label: "Monday 09:30", at: mon }])];
}
