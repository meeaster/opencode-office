// The schedule grammar and UTC matching shared by both cron runners and the YAML schemas.
const macros = new Map(Object.entries({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}));

const names = {
  month: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  weekday: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

/** One cron field: its range, and the names it accepts with the number of the first. */
type Field = { min: number; max: number; names?: string[]; offset?: number };

/** The values each field allows; undefined allows every value. Sunday is 0. */
export type ScheduleFields = { minute?: Set<number>; hour?: Set<number>; day?: Set<number>; month?: Set<number>; weekday?: Set<number> };

const fields: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: names.month, offset: 1 },
  { min: 0, max: 7, names: names.weekday, offset: 0 },
];

function value(token: string, field: Field): number {
  const index = field.names?.indexOf(token.toUpperCase()) ?? -1;

  if (/^\d+$/.test(token)) return Number(token);

  return index === -1 ? NaN : index + (field.offset ?? 0);
}

/** The set of values one cron field allows, or undefined when it allows every value. */
function parseField(text: string, field: Field): Set<number> | undefined {
  if (text === "*" || text === "?") return undefined;

  const allowed = new Set<number>();

  for (const part of text.split(",")) {
    const piece = /^(\*|[A-Za-z0-9]+)(?:-([A-Za-z0-9]+))?(?:\/(\d+))?$/.exec(part);

    if (piece === null) throw new Error(`can't read "${text}"`);

    const [, range, end, every] = piece;
    const from = range === "*" ? field.min : value(range, field);
    const last = end === undefined ? (range === "*" || every !== undefined ? field.max : from) : value(end, field);
    const step = every === undefined ? 1 : Number(every);

    if (!(from >= field.min && last <= field.max && from <= last && step > 0 && Number.isSafeInteger(step)) || (range === "*" && end !== undefined)) {
      throw new Error(`can't read "${text}"`);
    }

    for (let current = from; current <= last; current += step) allowed.add(current);
  }

  return allowed;
}

/**
 * The values each field of a five-field expression or a macro such as @daily allows (undefined:
 * every value), with Sunday always 0; undefined for other forms such as @reboot.
 */
export function scheduleFields(expression: string): ScheduleFields | undefined {
  const parts = (macros.get(expression) ?? expression).split(/[ \t]+/);

  if (parts.length !== 5) return undefined;

  const [minute, hour, day, month, weekday] = parts.map((part, index) => parseField(part, fields[index]));

  if (weekday?.has(7)) {
    weekday.delete(7);
    weekday.add(0);
  }

  return { minute, hour, day, month, weekday };
}

/** Schema predicate. In particular, a schedule must not inject another line in generated input. */
export function validSchedule(expression: string): boolean {
  if (!/^[\w@?*,/ \t-]+$/.test(expression) || /[\r\n]/.test(expression)) return false;

  try {
    return scheduleFields(expression) !== undefined;
  } catch {
    return false;
  }
}

/** Numeric supercronic input from the same fields used for catch-up. */
export function numericSchedule(fields: ScheduleFields): string {
  return [fields.minute, fields.hour, fields.day, fields.month, fields.weekday]
    .map((field) => field === undefined ? "*" : [...field].sort((a, b) => a - b).join(","))
    .join(" ");
}

/** A matcher for a five-field expression or a macro such as @daily; undefined for other forms. */
export function schedule({ minute, hour, day, month, weekday }: ScheduleFields): (date: Date) => boolean {

  // Cron's rule: when both day fields are restricted, either one matching is enough.

  return (date: Date) => {
    const dayMatches = day === undefined || day.has(date.getUTCDate());
    const weekdayMatches = weekday === undefined || weekday.has(date.getUTCDay());

    return (
      (minute === undefined || minute.has(date.getUTCMinutes())) &&
      (hour === undefined || hour.has(date.getUTCHours())) &&
      (month === undefined || month.has(date.getUTCMonth() + 1)) &&
      (day !== undefined && weekday !== undefined ? dayMatches || weekdayMatches : dayMatches && weekdayMatches)
    );
  };
}

/** The latest minute at or before `now` that the schedule matches, within the last year. */
export function lastDue(matches: (date: Date) => boolean, now: Date): Date | undefined {
  const minute = new Date(now);

  minute.setUTCSeconds(0, 0);

  for (let step = 0; step < 366 * 24 * 60; step++) {
    if (matches(minute)) return minute;

    minute.setUTCMinutes(minute.getUTCMinutes() - 1);
  }

  return undefined;
}
