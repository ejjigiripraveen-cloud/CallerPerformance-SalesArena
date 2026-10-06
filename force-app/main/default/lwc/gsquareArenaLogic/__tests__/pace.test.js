import { paceState, mtdState } from "c/gsquareArenaLogic";

describe("paceState", () => {
  it("ahead of typical", () =>
    expect(paceState(64, 58)).toEqual({
      tone: "good",
      text: "+6 vs typical 58"
    }));
  it("behind typical", () =>
    expect(paceState(18, 22)).toEqual({
      tone: "warning",
      text: "4 behind typical 22"
    }));
  it("on pace", () =>
    expect(paceState(2, 2)).toEqual({
      tone: "neutral",
      text: "On pace, typical 2"
    }));
  it("far behind is critical", () =>
    expect(paceState(10, 20).tone).toBe("critical"));
  it("no baseline", () => {
    expect(paceState(5, null)).toEqual({
      tone: "neutral",
      text: "No baseline yet"
    });
    expect(paceState(5, 0)).toEqual({
      tone: "neutral",
      text: "No baseline yet"
    });
  });
  it("rounds typical in text", () =>
    expect(paceState(20, 21.6).text).toBe("2 behind typical 22"));
});

describe("mtdState", () => {
  it("percent when last month is 20 or more", () =>
    expect(mtdState(1412, 1307, "Sep")).toEqual({
      tone: "good",
      text: "+8% vs Sep"
    }));
  it("absolute when last month is under 20", () =>
    expect(mtdState(11, 9, "Sep")).toEqual({
      tone: "good",
      text: "+2 vs Sep"
    }));
  it("negative percent uses a minus sign", () =>
    expect(mtdState(412, 425, "Sep")).toEqual({
      tone: "warning",
      text: "\u22123% vs Sep"
    }));
  it("no comparison", () =>
    expect(mtdState(5, null, "Sep")).toEqual({ tone: "neutral", text: "" }));
});
