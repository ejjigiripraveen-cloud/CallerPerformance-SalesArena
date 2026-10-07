import { createElement } from "lwc";
import GsquareSalesArena from "c/gsquareSalesArenaWallTV_V2";
import getDashboard from "@salesforce/apex/GSquareSalesArenaControllerWallTV_V2.getDashboard";
import { subscribe } from "lightning/empApi";
import { getPicklistValues } from "lightning/uiObjectInfoApi";

jest.mock(
  "@salesforce/apex/GSquareSalesArenaControllerWallTV_V2.getDashboard",
  () => {
    const { createApexTestWireAdapter } = require("@salesforce/sfdx-lwc-jest");
    return { default: createApexTestWireAdapter(jest.fn()) };
  },
  { virtual: true }
);
jest.mock(
  "@salesforce/apex",
  () => ({ refreshApex: jest.fn(() => Promise.resolve()) }),
  { virtual: true }
);

const MIN = 60000;
// 10:30 IST, before noon
const T0 = Date.UTC(2026, 9, 6, 5, 0);

function person(id, name, metrics, extra = {}) {
  return {
    userId: id,
    name,
    initials: name
      .split(" ")
      .map((s) => s[0])
      .join(""),
    photoUrl: null,
    tlId: "T1",
    tlName: "Arun",
    managerId: "M1",
    managerName: "Ravi",
    headId: "H1",
    headName: "Senthil",
    zone: "Zone 1",
    profileName: "Presales outbound",
    availability: true,
    tenureEligible: true,
    metrics: {
      allocation: 0,
      svScheduled: 0,
      svConducted: 0,
      booking: 0,
      talktime: 0,
      callsMade: 0,
      ...metrics
    },
    mtdMetrics: { allocation: 0, svConducted: 0, booking: 0 },
    ...extra
  };
}

const DATA = {
  zone: "Zone 1",
  zoneConfigured: true,
  metricDefs: [
    { key: "allocation", label: "Allocation", unit: "", isRate: false },
    { key: "svScheduled", label: "SV scheduled", unit: "", isRate: false },
    { key: "svConducted", label: "SV conducted", unit: "", isRate: false },
    { key: "booking", label: "Booking", unit: "", isRate: false },
    { key: "talktime", label: "Talktime", unit: "m", isRate: false }
  ],
  people: [
    person("u1", "Priya R", { allocation: 5, svConducted: 2, booking: 1 }),
    person("u2", "Karthik M", { allocation: 3 })
  ],
  totals: {
    allocation: 8,
    svScheduled: 0,
    svConducted: 2,
    booking: 1,
    talktime: 0
  },
  mtdTotals: { allocation: 120, svConducted: 30, booking: 4 },
  zoneRace: [
    { zone: "Zone 1", svConducted: 2 },
    { zone: "Zone 2", svConducted: 1 }
  ],
  baseline: { hourly: {}, lastMonthToDate: {}, tlHourly: {} },
  tlTeamSizes: { T1: 2 },
  settings: {
    refreshSeconds: 180,
    watchlistMinWeak: 3,
    watchlistMaxEntries: 25,
    alertCriticalZeroCount: 3
  },
  warnings: []
};

let bookingHandler;
const flush = () => Promise.resolve();

function mount(zone = "Zone 1") {
  const el = createElement("c-gsquare-sales-arena-wall-t-v_-v2", { is: GsquareSalesArena });
  el.zone = zone;
  document.body.appendChild(el);
  return el;
}

const text = (el, sel) => {
  const n = el.shadowRoot.querySelector(sel);
  return n ? n.textContent : null;
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  window.localStorage.clear();
  subscribe.mockImplementation((channel, replay, cb) => {
    bookingHandler = cb;
    return Promise.resolve({ id: "sub" });
  });
  delete window.location;
  window.location = { reload: jest.fn() };
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe("c-gsquare-sales-arena-wall-t-v_-v2", () => {
  it("asks for a zone when none is configured", async () => {
    const el = mount("");
    await flush();
    expect(text(el, ".notice")).toBe(
      "Choose a zone from the menu at the top right."
    );
    expect(el.shadowRoot.querySelector("c-gsquare-arena-hero")).toBeNull();
  });

  it("renders the hero and the first scene once data arrives", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    const hero = el.shadowRoot.querySelector("c-gsquare-arena-hero");
    expect(hero.zoneName).toBe("Zone 1 Tele Arena");
    expect(hero.tiles.map((t) => t.today)).toEqual([8, 2, 1]);
    expect(hero.tiles[0].mtd).toBe(120);
    expect(text(el, ".stitle")).toBe("Allocation");
    expect(
      el.shadowRoot.querySelector("c-gsquare-arena-board").rows[0].name
    ).toBe("Priya R");
    expect(subscribe).toHaveBeenCalledWith(
      "/event/GSquare_Arena_Booking__e",
      -1,
      expect.any(Function)
    );
  });

  it("moves to the next scene after 30 s before noon", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    jest.advanceTimersByTime(30000);
    await flush();
    expect(text(el, ".stitle")).toBe("SV scheduled");
  });

  it("shows a booking takeover for 10 s, ignores duplicates, then resumes the scene", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    await flush();
    jest.advanceTimersByTime(5000);
    const evt = {
      data: {
        payload: {
          Opportunity_Id__c: "006A",
          Caller_Id__c: "u1",
          Caller_Name__c: "Priya R",
          Caller_Initials__c: "PR",
          Zone__c: "Zone 1",
          Tl_Name__c: "Arun"
        }
      }
    };
    bookingHandler(evt);
    bookingHandler(evt);
    jest.advanceTimersByTime(1000);
    await flush();
    const tk = el.shadowRoot.querySelector("c-gsquare-arena-takeover");
    expect(tk.booking.callerName).toBe("Priya R");
    expect(tk.booking.countText).toBe(
      "Booking 2 today in Zone 1, 5 this month"
    );
    jest.advanceTimersByTime(10000);
    await flush();
    expect(el.shadowRoot.querySelector("c-gsquare-arena-takeover")).toBeNull();
    expect(text(el, ".stitle")).toBe("Allocation");
    jest.advanceTimersByTime(10000);
    await flush();
    expect(el.shadowRoot.querySelector("c-gsquare-arena-takeover")).toBeNull();
  });

  it("celebrates a booking found on refresh when no event arrived", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    const later = {
      ...DATA,
      people: [
        person("u1", "Priya R", { allocation: 5, svConducted: 2, booking: 1 }),
        person("u2", "Karthik M", { allocation: 3, booking: 1 })
      ],
      totals: { ...DATA.totals, booking: 2 }
    };
    getDashboard.emit(later);
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(
      el.shadowRoot.querySelector("c-gsquare-arena-takeover").booking.callerName
    ).toBe("Karthik M");
  });

  it("month count follows the latest refresh, not the highest value seen", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    await flush();
    const newMonth = {
      ...DATA,
      totals: { ...DATA.totals, booking: 0 },
      mtdTotals: { ...DATA.mtdTotals, booking: 0 },
      people: DATA.people.map((p) => ({
        ...p,
        metrics: { ...p.metrics, booking: 0 }
      }))
    };
    getDashboard.emit(newMonth);
    await flush();
    bookingHandler({
      data: {
        payload: {
          Opportunity_Id__c: "006M",
          Caller_Id__c: "u1",
          Caller_Name__c: "Priya R",
          Zone__c: "Zone 1"
        }
      }
    });
    jest.advanceTimersByTime(1000);
    await flush();
    expect(
      el.shadowRoot.querySelector("c-gsquare-arena-takeover").booking.countText
    ).toBe("Booking 1 today in Zone 1, 1 this month");
  });

  it("reloads the page on an expired session", async () => {
    mount();
    getDashboard.error({ message: "Session expired or invalid" }, 401);
    await flush();
    expect(window.location.reload).toHaveBeenCalled();
  });

  it("flags paused data after 10 minutes without a successful refresh", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    jest.advanceTimersByTime(10 * MIN);
    await flush();
    const hero = el.shadowRoot.querySelector("c-gsquare-arena-hero");
    expect(hero.updatedText).toBe("Data paused, reconnecting");
    expect(hero.staleState).toBe("red");
  });

  it("has only the toolbar controls: zoom out, fit, zoom in, full screen and the zone picker", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    expect(el.shadowRoot.querySelectorAll(".tools button")).toHaveLength(4);
    expect(el.shadowRoot.querySelectorAll("select")).toHaveLength(1);
  });

  it("full screen covers the window with CSS and Esc leaves it", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    const expand = el.shadowRoot.querySelectorAll(".tools button")[3];
    expand.click();
    await flush();
    expect(el.shadowRoot.querySelector(".fit.expanded")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flush();
    expect(el.shadowRoot.querySelector(".fit.expanded")).toBeNull();
  });

  it("zooms in steps of 10% and remembers the zoom", async () => {
    const el = mount();
    getDashboard.emit(DATA);
    await flush();
    const [out, fit, zin] = el.shadowRoot.querySelectorAll(".tools button");
    expect(fit.textContent).toBe("100%");
    zin.click();
    await flush();
    expect(fit.textContent).toBe("110%");
    expect(window.localStorage.getItem("gsquareArenaTv.zoom")).toBe("1.1");
    out.click();
    out.click();
    await flush();
    expect(fit.textContent).toBe("90%");
    fit.click();
    await flush();
    expect(fit.textContent).toBe("100%");
  });

  describe("zone picker", () => {
    const zoneSelect = (el) =>
      el.shadowRoot.querySelector(".zone-pick-select");

    it("requests zones with the master record type (User has no record types)", async () => {
      mount("");
      await flush();
      expect(getPicklistValues.getLastConfig()).toEqual(
        expect.objectContaining({ recordTypeId: "012000000000000AAA" })
      );
    });

    it("lists every zone from the User.Zone__c picklist", async () => {
      const el = mount("");
      getPicklistValues.emit({
        values: [{ value: "Zone 1" }, { value: "Zone 2" }]
      });
      await flush();
      const values = [...zoneSelect(el).querySelectorAll("option")]
        .map((o) => o.value)
        .filter(Boolean);
      expect(values).toEqual(["Zone 1", "Zone 2"]);
    });

    it("switches zone, reloads for it and remembers the choice", async () => {
      const el = mount("Zone 1");
      getDashboard.emit(DATA);
      getPicklistValues.emit({
        values: [{ value: "Zone 1" }, { value: "Zone 2" }]
      });
      await flush();
      const select = zoneSelect(el);
      select.value = "Zone 2";
      select.dispatchEvent(new CustomEvent("change"));
      await flush();
      expect(getDashboard.getLastConfig()).toEqual({ zone: "Zone 2" });
      expect(window.localStorage.getItem("gsquareArenaTv.zone")).toBe("Zone 2");
      expect(text(el, ".notice")).toBe("Loading Zone 2");
    });

    it("uses the remembered zone after a reload", async () => {
      window.localStorage.setItem("gsquareArenaTv.zone", "Zone 2");
      mount("");
      await flush();
      expect(getDashboard.getLastConfig()).toEqual({ zone: "Zone 2" });
    });

    it("ignores bookings until a zone is chosen", async () => {
      mount("");
      await flush();
      bookingHandler({
        data: { payload: { Opportunity_Id__c: "o1", Zone__c: "Zone 1" } }
      });
      jest.advanceTimersByTime(1000);
      await flush();
      expect(document.body.firstChild.shadowRoot.querySelector("c-gsquare-arena-takeover")).toBeNull();
    });
  });
});
