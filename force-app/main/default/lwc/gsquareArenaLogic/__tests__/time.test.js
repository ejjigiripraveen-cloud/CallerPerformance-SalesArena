import { istParts, typicalByNow } from "c/gsquareArenaLogic";

describe("istParts", () => {
  it("converts UTC to IST parts", () => {
    expect(istParts(Date.UTC(2026, 9, 6, 8, 44))).toEqual({
      dateKey: "2026-10-06",
      hour: 14,
      minute: 14,
      weekday: 2,
      dayOfMonth: 6,
      monthLabel: "Oct",
      prevMonthLabel: "Sep"
    });
  });
  it("rolls over to the next IST date", () => {
    const p = istParts(Date.UTC(2026, 9, 6, 18, 40));
    expect(p.dateKey).toBe("2026-10-07");
    expect(p.hour).toBe(0);
    expect(p.weekday).toBe(3);
  });
  it("January reports December as previous month", () => {
    expect(istParts(Date.UTC(2026, 0, 5, 6, 0)).prevMonthLabel).toBe("Dec");
  });
});

describe("typicalByNow", () => {
  const h = new Array(24).fill(0);
  h[13] = 20;
  h[14] = 24;
  it("interpolates within the hour", () => {
    expect(typicalByNow(h, { hour: 14, minute: 30 })).toBe(22);
  });
  it("uses 0 as the previous value at hour 0", () => {
    const z = new Array(24).fill(0);
    z[0] = 4;
    expect(typicalByNow(z, { hour: 0, minute: 30 })).toBe(2);
  });
  it("returns null without a baseline", () => {
    expect(typicalByNow(null, { hour: 10, minute: 0 })).toBeNull();
  });
});
