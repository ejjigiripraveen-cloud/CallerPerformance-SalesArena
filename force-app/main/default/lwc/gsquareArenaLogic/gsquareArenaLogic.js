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

/* ------------------------------------------------------------ playlist */

export const BOARD_METRICS = [
  "allocation",
  "svScheduled",
  "svConducted",
  "booking",
  "talktime"
];
const NO_BOTTOM_BOARD = new Set(["booking"]); // most callers have 0 bookings on any day
export const BOTTOM_BOARDS_FROM_HOUR = 12;

/* Team tables page instead of scrolling: nobody scrolls a wall TV. Sizes are
   in container-height units, so the same number of rows fits on every screen. */
export const TEAM_ROWS_PER_PAGE = 5;
export const TEAM_PAGE_SECONDS = 8;

export function pageCount(rowCount, perPage = TEAM_ROWS_PER_PAGE) {
  return Math.max(1, Math.ceil(rowCount / perPage));
}

/** The page on screen `elapsed` seconds into a scene lasting `seconds`. */
export function pageIndexAt(elapsed, seconds, pages) {
  if (pages <= 1) return 0;
  return Math.min(pages - 1, Math.floor(elapsed / (seconds / pages)));
}

export function pageRows(rows, pageIndex, perPage = TEAM_ROWS_PER_PAGE) {
  return rows.slice(pageIndex * perPage, (pageIndex + 1) * perPage);
}

/**
 * One ~3-minute cycle of scenes for the scene area. Team scenes stretch so
 * each page of a long team table gets at least TEAM_PAGE_SECONDS.
 */
export function buildPlaylist(
  ist,
  cycleIndex,
  { teamPages = 1, leaderPages = 1 } = {}
) {
  const afternoon = ist.hour >= BOTTOM_BOARDS_FROM_HOUR;
  const topSeconds = afternoon ? 20 : 30;
  const list = [];
  BOARD_METRICS.forEach((metricKey) => {
    list.push({
      id: `${metricKey}-top`,
      kind: "top",
      metricKey,
      seconds: topSeconds
    });
    if (afternoon && !NO_BOTTOM_BOARD.has(metricKey)) {
      list.push({
        id: `${metricKey}-bottom`,
        kind: "bottom",
        metricKey,
        seconds: 10
      });
    }
  });
  list.push({
    id: "team-tl",
    kind: "team",
    seconds: Math.max(25, teamPages * TEAM_PAGE_SECONDS)
  });
  if (afternoon) list.push({ id: "watchlist", kind: "watchlist", seconds: 15 });
  if (cycleIndex % 2 === 1)
    list.push({
      id: "team-leaders",
      kind: "leaders",
      seconds: Math.max(20, leaderPages * TEAM_PAGE_SECONDS)
    });
  return list;
}

/* -------------------------------------------------------------- boards */

const UNASSIGNED = "Unassigned";
export const ALERT_PROFILE = "Presales outbound";
const WATCHLIST_SCENE_LIMIT = 8; // two columns of four fit one scene
const TEAM_METRICS = [
  "allocation",
  "svScheduled",
  "svConducted",
  "booking",
  "talktime"
];

/** Bottom boards and Watchlist: available today, past tenure, outbound presales. */
export function isEligible(p) {
  return (
    p.availability === true &&
    p.tenureEligible === true &&
    p.profileName === ALERT_PROFILE
  );
}

const val = (p, key) => Number((p.metrics || {})[key]) || 0;

function toRow(p, key, rank) {
  return {
    rank,
    id: p.id,
    name: p.name,
    initials: p.initials,
    photoUrl: p.photoUrl || null,
    subLabel: `TL ${p.tlName || UNASSIGNED}`,
    value: val(p, key),
    movement: null
  };
}

export function topRows(people, key, n = 10) {
  return [...people]
    .sort((a, b) => val(b, key) - val(a, key) || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((p, i) => toRow(p, key, i + 1));
}

export function bottomRows(people, key, n = 5) {
  return people
    .filter(isEligible)
    .sort((a, b) => val(a, key) - val(b, key) || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((p, i) => toRow(p, key, i + 1));
}

const LEVELS = {
  tl: { id: "tlId", name: "tlName", prefix: "TL" },
  manager: { id: "managerId", name: "managerName", prefix: "Manager" },
  head: { id: "headId", name: "headName", prefix: "Head" }
};

/** Team rows for the TL table (level 'tl') or the leaders scene ('manager' | 'head'). */
export function teamRows(
  people,
  level,
  { tlTeamSizes = {}, tlPace = {} } = {}
) {
  const lv = LEVELS[level];
  const groups = new Map();
  people.forEach((p) => {
    const id = p[lv.id];
    if (!id || p[lv.name] === UNASSIGNED) return;
    if (!groups.has(id)) groups.set(id, { id, name: p[lv.name], members: [] });
    groups.get(id).members.push(p);
  });
  return [...groups.values()]
    .map((g) => {
      const row = {
        id: g.id,
        name: g.name,
        label: `${lv.prefix} ${g.name}`,
        pace: null
      };
      TEAM_METRICS.forEach((k) => {
        row[k] = g.members.reduce((s, p) => s + val(p, k), 0);
      });
      if (level === "tl") {
        const size = tlTeamSizes[g.id];
        if (size && size !== g.members.length) {
          row.label = `${row.label} \u00b7 ${g.members.length} of ${size} callers`;
        }
        row.pace = tlPace[g.id] || null;
      }
      return row;
    })
    .sort(
      (a, b) => b.svConducted - a.svConducted || a.name.localeCompare(b.name)
    );
}

/**
 * Existing watchlist rules (below the zone average on >= watchlistMinWeak
 * metrics; critical at >= alertCriticalZeroCount zeros; worst first),
 * listing eligible callers only. Averages use every assigned caller.
 */
export function watchlistRows(people, metricDefs, settings) {
  const mapped = people.filter((p) => p.tlName && p.tlName !== UNASSIGNED);
  if (!mapped.length) return [];
  const scored = metricDefs.filter((m) => !m.isRate);
  const avg = {};
  scored.forEach((m) => {
    avg[m.key] = mapped.reduce((s, p) => s + val(p, m.key), 0) / mapped.length;
  });
  const out = [];
  mapped.filter(isEligible).forEach((p) => {
    const reasons = scored
      .filter((m) => val(p, m.key) < avg[m.key])
      .map((m) => ({
        metric: m.label,
        value: Math.round(val(p, m.key)),
        unit: m.unit || "",
        isZero: val(p, m.key) === 0
      }));
    if (reasons.length >= settings.watchlistMinWeak) {
      const zeros = reasons.filter((r) => r.isZero).length;
      out.push({
        id: p.id,
        name: p.name,
        initials: p.initials,
        photoUrl: p.photoUrl || null,
        reasons,
        zeros,
        severity:
          zeros >= settings.alertCriticalZeroCount ? "critical" : "important"
      });
    }
  });
  out.sort(
    (a, b) =>
      b.zeros - a.zeros ||
      b.reasons.length - a.reasons.length ||
      a.name.localeCompare(b.name)
  );
  return out.slice(
    0,
    Math.min(
      settings.watchlistMaxEntries || WATCHLIST_SCENE_LIMIT,
      WATCHLIST_SCENE_LIMIT
    )
  );
}

/** Rank change since the last refresh, per board. Returns new rows. */
export function applyMovement(rows, prevRanksByBoard, boardKey) {
  const prev = prevRanksByBoard.get(boardKey);
  return rows.map((r) => {
    const before = prev ? prev.get(r.id) : undefined;
    return { ...r, movement: before === undefined ? null : before - r.rank };
  });
}

/* -------------------------------------------------------------- TV ops */

const MINUTE = 60000;
export const STALE_AMBER_MIN = 6;
export const STALE_RED_MIN = 10;
export const OFFICE_START_HOUR = 9;
export const OFFICE_END_HOUR = 20;
export const DAILY_RELOAD = { hour: 8, minute: 30 };
const BURN_IN_STEPS = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 }
];

export function staleState(lastSuccessMs, nowMs) {
  if (!lastSuccessMs) return "red";
  const mins = (nowMs - lastSuccessMs) / MINUTE;
  if (mins >= STALE_RED_MIN) return "red";
  if (mins >= STALE_AMBER_MIN) return "amber";
  return "fresh";
}

export function updatedText(lastSuccessMs, nowMs) {
  if (staleState(lastSuccessMs, nowMs) === "red")
    return "Data paused, reconnecting";
  const mins = Math.floor((nowMs - lastSuccessMs) / MINUTE);
  return mins < 1 ? "Updated just now" : `Updated ${mins} min ago`;
}

export function isAuthError(error) {
  if (!error) return false;
  if (error.status === 401) return true;
  const msg = (error.body && error.body.message) || error.message || "";
  return /session (expired|invalid)|invalid session/i.test(msg);
}

export function shouldDailyReload(ist, lastReloadDateKey) {
  if (ist.dateKey === lastReloadDateKey) return false;
  return (
    ist.hour > DAILY_RELOAD.hour ||
    (ist.hour === DAILY_RELOAD.hour && ist.minute >= DAILY_RELOAD.minute)
  );
}

export function isDimmed(ist) {
  return ist.hour < OFFICE_START_HOUR || ist.hour >= OFFICE_END_HOUR;
}

export function burnInOffset(nowMs) {
  return BURN_IN_STEPS[Math.floor(nowMs / (5 * MINUTE)) % BURN_IN_STEPS.length];
}

/** FIFO of booking takeovers; an opportunity is celebrated once per page life. */
export class TakeoverQueue {
  constructor() {
    this.items = [];
    this.seen = new Set();
  }
  push(event) {
    const id = event && event.opportunityId;
    if (!id || this.seen.has(id)) return false;
    this.seen.add(id);
    this.items.push(event);
    return true;
  }
  next() {
    return this.items.shift() || null;
  }
  get size() {
    return this.items.length;
  }
}

/* --------------------------------------------- MTD export (temporary) */

const xmlEscape = (v) =>
  String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Excel 2003 XML workbook (opens in Excel as .xls), one worksheet per sheet;
 * the first row of each sheet is a bold header. Same format as the Caller
 * Performance tab's Export.
 */
export function buildWorkbookXml(sheets) {
  const worksheets = (sheets || [])
    .map((s) => {
      const rows = (s.rows || [])
        .map(
          (r, i) =>
            "<Row>" +
            r
              .map(
                (c) =>
                  `<Cell${i === 0 ? ' ss:StyleID="h"' : ""}><Data ss:Type="String">${xmlEscape(c)}</Data></Cell>`
              )
              .join("") +
            "</Row>"
        )
        .join("");
      // Excel sheet names: max 31 chars, no []:*?/\
      const name = xmlEscape(
        String(s.name || "Sheet")
          .replace(/[[\]:*?/\\]/g, " ")
          .slice(0, 31)
      );
      return `<Worksheet ss:Name="${name}"><Table>${rows}</Table></Worksheet>`;
    })
    .join("");
  return (
    '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>' +
    worksheets +
    "</Workbook>"
  );
}
