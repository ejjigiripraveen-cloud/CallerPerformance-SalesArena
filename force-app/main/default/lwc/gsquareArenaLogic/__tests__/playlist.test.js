import {
  buildPlaylist,
  BOARD_METRICS,
  pageCount,
  pageIndexAt,
  pageRows
} from "c/gsquareArenaLogic";

const total = (pl) => pl.reduce((s, x) => s + x.seconds, 0);

describe("buildPlaylist", () => {
  it("exports the five board metrics in order", () => {
    expect(BOARD_METRICS).toEqual([
      "allocation",
      "svScheduled",
      "svConducted",
      "booking",
      "talktime"
    ]);
  });

  it("before noon: tops only at 30 s, TL table 25 s, 175 s total", () => {
    const pl = buildPlaylist({ hour: 11 }, 0);
    expect(pl.map((x) => x.id)).toEqual([
      "allocation-top",
      "svScheduled-top",
      "svConducted-top",
      "booking-top",
      "talktime-top",
      "team-tl"
    ]);
    expect(
      pl.filter((x) => x.kind === "top").every((x) => x.seconds === 30)
    ).toBe(true);
    expect(pl.find((x) => x.id === "team-tl").seconds).toBe(25);
    expect(total(pl)).toBe(175);
  });

  it("from noon: bottoms and watchlist, no booking bottom, 180 s total", () => {
    const pl = buildPlaylist({ hour: 12 }, 0);
    expect(pl.map((x) => `${x.id} ${x.seconds}`)).toEqual([
      "allocation-top 20",
      "allocation-bottom 10",
      "svScheduled-top 20",
      "svScheduled-bottom 10",
      "svConducted-top 20",
      "svConducted-bottom 10",
      "booking-top 20",
      "talktime-top 20",
      "talktime-bottom 10",
      "team-tl 25",
      "watchlist 15"
    ]);
    expect(total(pl)).toBe(180);
    expect(pl.find((x) => x.id === "allocation-bottom")).toMatchObject({
      kind: "bottom",
      metricKey: "allocation"
    });
  });

  it("odd cycles append the leaders scene, even cycles do not", () => {
    expect(buildPlaylist({ hour: 9 }, 1).at(-1)).toEqual({
      id: "team-leaders",
      kind: "leaders",
      seconds: 20
    });
    expect(buildPlaylist({ hour: 15 }, 3).at(-1).id).toBe("team-leaders");
    expect(
      buildPlaylist({ hour: 15 }, 2).some((x) => x.id === "team-leaders")
    ).toBe(false);
  });

  it("stretches team scenes so each page gets 8 s", () => {
    const pl = buildPlaylist({ hour: 9 }, 1, { teamPages: 4, leaderPages: 3 });
    expect(pl.find((x) => x.id === "team-tl").seconds).toBe(32);
    expect(pl.find((x) => x.id === "team-leaders").seconds).toBe(24);
    // short tables keep the original minimums
    const short = buildPlaylist({ hour: 9 }, 1, { teamPages: 1, leaderPages: 2 });
    expect(short.find((x) => x.id === "team-tl").seconds).toBe(25);
    expect(short.find((x) => x.id === "team-leaders").seconds).toBe(20);
  });
});

describe("team table paging", () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}` }));

  it("splits into pages of 5, as many pages as the TLs need", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(5)).toBe(1);
    expect(pageCount(6)).toBe(2);
    expect(pageCount(14)).toBe(3);
    expect(pageCount(23)).toBe(5);
    expect(pageRows(rows, 2).map((r) => r.id)).toEqual([
      "t10",
      "t11",
      "t12",
      "t13"
    ]);
  });

  it("walks the pages evenly across the scene", () => {
    expect(pageIndexAt(0, 25, 3)).toBe(0);
    expect(pageIndexAt(9, 25, 3)).toBe(1);
    expect(pageIndexAt(24, 25, 3)).toBe(2);
    expect(pageIndexAt(99, 25, 3)).toBe(2);
    expect(pageIndexAt(10, 25, 1)).toBe(0);
  });
});
