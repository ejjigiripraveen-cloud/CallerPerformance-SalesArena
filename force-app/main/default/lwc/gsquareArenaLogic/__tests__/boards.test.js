import {
  isEligible,
  topRows,
  bottomRows,
  BOTTOM_ROWS,
  teamRows,
  watchlistRows,
  applyMovement
} from "c/gsquareArenaLogic";

const person = (id, name, tlId, metrics, extra = {}) => ({
  id,
  name,
  initials: name
    .split(" ")
    .map((s) => s[0])
    .join(""),
  photoUrl: null,
  tlId,
  tlName: { T1: "Arun", T2: "Sushma" }[tlId] || "Unassigned",
  managerId: "M1",
  managerName: "Ravi",
  headId: "H1",
  headName: "Senthil",
  profileName: "Presales outbound",
  availability: true,
  tenureEligible: true,
  metrics,
  mtdMetrics: {},
  ...extra
});

describe("isEligible", () => {
  it("requires availability true, tenure and the Presales outbound profile", () => {
    expect(isEligible(person("a", "A B", "T1", {}))).toBe(true);
    expect(
      isEligible(person("a", "A B", "T1", {}, { availability: false }))
    ).toBe(false);
    expect(
      isEligible(person("a", "A B", "T1", {}, { availability: null }))
    ).toBe(false);
    expect(
      isEligible(person("a", "A B", "T1", {}, { tenureEligible: false }))
    ).toBe(false);
    expect(
      isEligible(person("a", "A B", "T1", {}, { profileName: "Team Lead" }))
    ).toBe(false);
  });
});

describe("topRows", () => {
  const people = Array.from({ length: 12 }, (_, i) =>
    person(`p${i}`, `Name ${String.fromCharCode(65 + i)}`, "T1", {
      svConducted: i % 4
    })
  );
  it("sorts desc, ties by name, ranks 1..10, caps at 10", () => {
    const rows = topRows(people, "svConducted");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({
      rank: 1,
      value: 3,
      name: "Name D",
      subLabel: "TL Arun",
      movement: null
    });
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows[1].name).toBe("Name H");
  });
  it("lists people with zero values", () => {
    const rows = topRows(
      [person("x", "Zed Y", "T1", { booking: 0 })],
      "booking"
    );
    expect(rows[0].value).toBe(0);
  });
});

describe("bottomRows", () => {
  it("only eligible people, lowest first, zero performers included", () => {
    const people = [
      person("a", "Anu K", "T1", { allocation: 0 }),
      person("b", "Bala S", "T1", { allocation: 0 }, { availability: false }),
      person("c", "Chitra V", "T1", { allocation: 0 }, { availability: null }),
      person("d", "Deepa M", "T1", { allocation: 2 }),
      person("e", "Esh R", "T1", { allocation: 1 }, { tenureEligible: false }),
      person(
        "f",
        "Fathima N",
        "T1",
        { allocation: 1 },
        { profileName: "Team Lead" }
      ),
      person("g", "Gokul R", "T1", { allocation: 3 }),
      person("h", "Hari V", "T1", { allocation: 4 }),
      person("i", "Indu P", "T1", { allocation: 5 }),
      person("j", "Jaya T", "T1", { allocation: 6 })
    ];
    // n = 5 keeps the original expectation; the TV default is BOTTOM_ROWS (10)
    const rows = bottomRows(people, "allocation", 5);
    expect(rows.map((r) => r.name)).toEqual([
      "Anu K",
      "Deepa M",
      "Gokul R",
      "Hari V",
      "Indu P"
    ]);
    expect(rows[0]).toMatchObject({ rank: 1, value: 0 });
  });

  it("shows up to 10 by default", () => {
    expect(BOTTOM_ROWS).toBe(10);
    const many = Array.from({ length: 14 }, (_, i) =>
      person(`p${i}`, `Caller ${String(i).padStart(2, "0")}`, "T1", { allocation: i })
    );
    const rows = bottomRows(many, "allocation");
    expect(rows).toHaveLength(10);
    expect(rows[9]).toMatchObject({ rank: 10, value: 9 });
  });
});

describe("teamRows", () => {
  const people = [
    ...Array.from({ length: 6 }, (_, i) =>
      person(`a${i}`, `Arun Caller ${i}`, "T1", {
        allocation: 1,
        svScheduled: 1,
        svConducted: 1,
        booking: 0,
        talktime: 10
      })
    ),
    person("s1", "Sushma Caller", "T2", {
      allocation: 2,
      svScheduled: 0,
      svConducted: 0,
      booking: 1,
      talktime: 5
    })
  ];
  it("labels cross-zone TLs with partial counts and sums metrics", () => {
    const rows = teamRows(people, "tl", {
      tlTeamSizes: { T1: 11, T2: 1 },
      tlPace: { T1: { tone: "warning", text: "2 behind typical 8" } }
    });
    const arun = rows.find((r) => r.id === "T1");
    expect(arun).toMatchObject({
      name: "Arun",
      label: "TL Arun \u00b7 6 of 11 callers",
      allocation: 6,
      svConducted: 6,
      talktime: 60
    });
    expect(arun.pace).toEqual({ tone: "warning", text: "2 behind typical 8" });
    const sushma = rows.find((r) => r.id === "T2");
    expect(sushma.label).toBe("TL Sushma");
    expect(sushma.pace).toBeNull();
  });
  it("sorts teams by SV conducted, then name", () => {
    expect(
      teamRows(people, "tl", { tlTeamSizes: {} }).map((r) => r.id)
    ).toEqual(["T1", "T2"]);
  });
  it("groups by manager and head without pace", () => {
    const m = teamRows(people, "manager", {});
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      id: "M1",
      label: "Manager Ravi",
      allocation: 8,
      pace: null
    });
    expect(teamRows(people, "head", {})[0].label).toBe("Head Senthil");
  });
  it("excludes Unassigned TL groups", () => {
    const rows = teamRows(
      [person("u", "U U", null, { allocation: 1 })],
      "tl",
      {}
    );
    expect(rows).toEqual([]);
  });
});

describe("watchlistRows", () => {
  const defs = [
    { key: "allocation", label: "Allocation", isRate: false, unit: "" },
    { key: "svConducted", label: "SV conducted", isRate: false, unit: "" },
    { key: "talktime", label: "Talktime", isRate: false, unit: "m" },
    { key: "condVsSched", label: "Cond vs sched", isRate: true, unit: "%" }
  ];
  const settings = {
    watchlistMinWeak: 2,
    watchlistMaxEntries: 25,
    alertCriticalZeroCount: 3
  };
  const people = [
    person("a", "Strong A", "T1", {
      allocation: 9,
      svConducted: 5,
      talktime: 120
    }),
    person("b", "Zero B", "T1", { allocation: 0, svConducted: 0, talktime: 0 }),
    person("c", "Weak C", "T1", {
      allocation: 1,
      svConducted: 1,
      talktime: 100
    }),
    person(
      "d",
      "Absent D",
      "T1",
      { allocation: 0, svConducted: 0, talktime: 0 },
      { availability: false }
    )
  ];
  it("lists eligible below-average callers, worst first, severity by zeros", () => {
    const rows = watchlistRows(people, defs, settings);
    expect(rows.map((r) => r.name)).toEqual(["Zero B", "Weak C"]);
    expect(rows[0]).toMatchObject({ severity: "critical", zeros: 3 });
    expect(rows[0].reasons.map((r) => r.metric)).toEqual([
      "Allocation",
      "SV conducted",
      "Talktime"
    ]);
    expect(rows[1].severity).toBe("important");
  });
  it("caps at the scene limit", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      person(`z${i}`, `Zero ${i}`, "T1", {
        allocation: 0,
        svConducted: 0,
        talktime: 0
      })
    );
    expect(watchlistRows([...many, people[0]], defs, settings)).toHaveLength(8);
  });
});

describe("applyMovement", () => {
  it("compares with previous ranks for the same board", () => {
    const prev = new Map([["svConducted-top", new Map([["a", 4]])]]);
    const out = applyMovement(
      [
        { id: "a", rank: 2 },
        { id: "b", rank: 1 }
      ],
      prev,
      "svConducted-top"
    );
    expect(out).toEqual([
      { id: "a", rank: 2, movement: 2 },
      { id: "b", rank: 1, movement: null }
    ]);
  });
  it("returns null movement when the board has no history", () => {
    expect(
      applyMovement([{ id: "a", rank: 1 }], new Map(), "x")[0].movement
    ).toBeNull();
  });
});
