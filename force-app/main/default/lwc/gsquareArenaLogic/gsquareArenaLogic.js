/**
 * Pure rules for the Sales Arena zone TV wall. No DOM, no Apex: every
 * function here is unit-tested in __tests__ and consumed by the LWCs.
 */

const TZ = "Asia/Kolkata";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const MINUS = "\u2212";

const istFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23"
});

/* ---------------------------------------------------------------- time */

export function istParts(nowMs) {
  const p = {};
  istFormat.formatToParts(new Date(nowMs)).forEach((x) => {
    p[x.type] = x.value;
  });
  const month = Number(p.month);
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
    dayOfMonth: Number(p.day),
    monthLabel: MONTHS[month - 1],
    prevMonthLabel: MONTHS[(month + 10) % 12]
  };
}

/** Typical cumulative count at this moment, interpolated inside the hour. */
export function typicalByNow(hourly, ist) {
  if (!Array.isArray(hourly) || hourly.length < 24) return null;
  const prev = ist.hour === 0 ? 0 : Number(hourly[ist.hour - 1]) || 0;
  const cur = Number(hourly[ist.hour]) || 0;
  return prev + ((cur - prev) * ist.minute) / 60;
}

/* ---------------------------------------------------------------- pace */

export function paceState(today, typical) {
  if (!typical) return { tone: "neutral", text: "No baseline yet" };
  const typ = Math.round(typical);
  const ratio = today / typical;
  const tone =
    ratio >= 1.05
      ? "good"
      : ratio >= 0.95
        ? "neutral"
        : ratio >= 0.8
          ? "warning"
          : "critical";
  const diff = Math.round(today - typical);
  let text;
  if (diff > 0) text = `+${diff} vs typical ${typ}`;
  else if (diff < 0) text = `${-diff} behind typical ${typ}`;
  else text = `On pace, typical ${typ}`;
  return { tone, text };
}

export function mtdState(mtd, lastMonthToDate, prevMonthLabel) {
  if (lastMonthToDate === null || lastMonthToDate === undefined)
    return { tone: "neutral", text: "" };
  const diff = mtd - lastMonthToDate;
  const tone = diff >= 0 ? "good" : "warning";
  const sign = diff >= 0 ? "+" : MINUS;
  if (lastMonthToDate < 20)
    return {
      tone,
      text: `${sign}${Math.abs(Math.round(diff))} vs ${prevMonthLabel}`
    };
  const pct = Math.round((diff / lastMonthToDate) * 100);
  return {
    tone: pct >= 0 ? "good" : "warning",
    text: `${pct >= 0 ? "+" : MINUS}${Math.abs(pct)}% vs ${prevMonthLabel}`
  };
}
