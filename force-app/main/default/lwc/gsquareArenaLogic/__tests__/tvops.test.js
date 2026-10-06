import {
  staleState,
  updatedText,
  isAuthError,
  shouldDailyReload,
  isDimmed,
  burnInOffset,
  TakeoverQueue
} from "c/gsquareArenaLogic";

const MIN = 60000;

describe("staleness", () => {
  const t0 = 1_000_000;
  it("fresh under 6 min, amber from 6, red from 10", () => {
    expect(staleState(t0, t0 + 5 * MIN)).toBe("fresh");
    expect(staleState(t0, t0 + 6 * MIN)).toBe("amber");
    expect(staleState(t0, t0 + 10 * MIN)).toBe("red");
  });
  it("text", () => {
    expect(updatedText(t0, t0 + 20000)).toBe("Updated just now");
    expect(updatedText(t0, t0 + 4 * MIN + 5000)).toBe("Updated 4 min ago");
    expect(updatedText(t0, t0 + 10 * MIN)).toBe("Data paused, reconnecting");
  });
  it("no success yet counts as red", () => {
    expect(staleState(null, t0)).toBe("red");
  });
});

describe("isAuthError", () => {
  it("detects expired sessions", () => {
    expect(isAuthError({ status: 401 })).toBe(true);
    expect(
      isAuthError({ body: { message: "Session expired or invalid" } })
    ).toBe(true);
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});

describe("daily reload", () => {
  it("reloads once per IST date from 08:30", () => {
    expect(
      shouldDailyReload(
        { dateKey: "2026-10-06", hour: 8, minute: 29 },
        "2026-10-05"
      )
    ).toBe(false);
    expect(
      shouldDailyReload(
        { dateKey: "2026-10-06", hour: 8, minute: 30 },
        "2026-10-05"
      )
    ).toBe(true);
    expect(
      shouldDailyReload(
        { dateKey: "2026-10-06", hour: 13, minute: 0 },
        "2026-10-06"
      )
    ).toBe(false);
  });
});

describe("isDimmed", () => {
  it("dims outside 09:00-20:00 IST", () => {
    expect(isDimmed({ hour: 8, minute: 59 })).toBe(true);
    expect(isDimmed({ hour: 9, minute: 0 })).toBe(false);
    expect(isDimmed({ hour: 19, minute: 59 })).toBe(false);
    expect(isDimmed({ hour: 20, minute: 0 })).toBe(true);
  });
});

describe("burnInOffset", () => {
  it("cycles four 2px positions every 5 minutes", () => {
    expect(burnInOffset(0)).toEqual({ x: 0, y: 0 });
    expect(burnInOffset(5 * MIN)).toEqual({ x: 2, y: 0 });
    expect(burnInOffset(10 * MIN)).toEqual({ x: 2, y: 2 });
    expect(burnInOffset(15 * MIN)).toEqual({ x: 0, y: 2 });
    expect(burnInOffset(20 * MIN)).toEqual({ x: 0, y: 0 });
  });
});

describe("TakeoverQueue", () => {
  it("dedupes by opportunityId and serves FIFO", () => {
    const q = new TakeoverQueue();
    expect(q.push({ opportunityId: "006A" })).toBe(true);
    expect(q.push({ opportunityId: "006A" })).toBe(false);
    expect(q.push({ opportunityId: "006B" })).toBe(true);
    expect(q.size).toBe(2);
    expect(q.next().opportunityId).toBe("006A");
    expect(q.push({ opportunityId: "006A" })).toBe(false);
    expect(q.next().opportunityId).toBe("006B");
    expect(q.next()).toBeNull();
  });
  it("ignores events without an id", () => {
    expect(new TakeoverQueue().push({})).toBe(false);
  });
});
