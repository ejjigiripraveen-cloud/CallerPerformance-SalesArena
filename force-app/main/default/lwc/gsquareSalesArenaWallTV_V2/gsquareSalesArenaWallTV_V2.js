import { LightningElement, api, wire } from "lwc";
import { refreshApex } from "@salesforce/apex";
import getDashboard from "@salesforce/apex/GSquareSalesArenaControllerWallTV_V2.getDashboard";
import { subscribe, onError as onEmpError } from "lightning/empApi";
import {
  istParts,
  typicalByNow,
  paceState,
  mtdState,
  buildPlaylist,
  topRows,
  bottomRows,
  teamRows,
  watchlistRows,
  applyMovement,
  BOARD_METRICS,
  staleState,
  updatedText,
  isAuthError,
  shouldDailyReload,
  isDimmed,
  burnInOffset,
  TakeoverQueue
} from "c/gsquareArenaLogic";

const BOOKING_CHANNEL = "/event/GSquare_Arena_Booking__e";
const TAKEOVER_SECONDS = 10;
const DEFAULT_REFRESH_SECONDS = 180;
const HERO_KEYS = ["allocation", "svConducted", "booking"];
const FALLBACK_LABELS = {
  allocation: "Allocation",
  svScheduled: "SV scheduled",
  svConducted: "SV conducted",
  booking: "Booking",
  talktime: "Talktime"
};

/**
 * Sales Arena zone TV wall. One instance per zone TV (Lightning App Page with
 * the `zone` property set). All rules live in c/gsquareArenaLogic; this class
 * owns the wire, the timers and the booking-event subscription. Nothing on
 * the wall is clickable.
 */
export default class GsquareSalesArena extends LightningElement {
  @api zone;

  data;
  people = [];
  nowMs = Date.now();
  lastSuccessMs = null;
  wiredResult;

  cycle = 0;
  sceneIndex = 0;
  sceneElapsed = 0;
  dateKey;
  lastReloadKey;

  prevRanks = new Map();
  currRanks = new Map();

  queue = new TakeoverQueue();
  activeBooking = null;
  takeoverLeft = 0;
  celebratedByCaller = new Map();
  zoneBookingsToday = 0;
  zoneBookingsMtd = 0;

  tickTimer;
  refreshTimer;

  /* ------------------------------------------------------------ lifecycle */

  connectedCallback() {
    const ist = istParts(Date.now());
    this.dateKey = ist.dateKey;
    // a page opened after 08:30 is already fresh for today
    this.lastReloadKey = shouldDailyReload(ist, null) ? ist.dateKey : null;
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.tickTimer = setInterval(() => this.tick(), 1000);
    if (this.zoneParam) this.subscribeToBookings();
  }

  disconnectedCallback() {
    clearInterval(this.tickTimer);
    clearInterval(this.refreshTimer);
  }

  get zoneParam() {
    const z = typeof this.zone === "string" ? this.zone.trim() : "";
    return z || undefined;
  }

  get zoneConfigured() {
    return Boolean(this.zoneParam);
  }

  /* ----------------------------------------------------------------- data */

  @wire(getDashboard, { zone: "$zoneParam" })
  wiredDashboard(result) {
    this.wiredResult = result;
    if (result.data) this.onData(result.data);
    else if (result.error) this.onDataError(result.error);
  }

  onData(data) {
    (data.warnings || []).forEach((w) => console.warn("[Sales Arena]", w));
    const people = (data.people || []).map((p) => ({
      ...p,
      id: p.userId,
      metrics: p.metrics || {},
      mtdMetrics: p.mtdMetrics || {}
    }));
    const firstLoad = !this.data;
    this.detectBookingsOnRefresh(people, firstLoad);
    this.rotateRanks(people);
    this.people = people;
    this.data = data;
    this.lastSuccessMs = Date.now();
    // each refresh is the truth; events only add to it until the next one
    this.zoneBookingsToday = (data.totals || {}).booking || 0;
    this.zoneBookingsMtd = (data.mtdTotals || {}).booking || 0;
    if (firstLoad) this.startRefreshTimer((data.settings || {}).refreshSeconds);
  }

  onDataError(error) {
    if (isAuthError(error)) {
      this.reloadPage();
      return;
    }
    console.warn("[Sales Arena] refresh failed", error);
  }

  startRefreshTimer(seconds) {
    clearInterval(this.refreshTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this.refreshTimer = setInterval(
      () => {
        if (this.wiredResult) refreshApex(this.wiredResult);
      },
      (seconds || DEFAULT_REFRESH_SECONDS) * 1000
    );
  }

  rotateRanks(people) {
    const next = new Map();
    BOARD_METRICS.forEach((k) => {
      next.set(
        `${k}-top`,
        new Map(topRows(people, k).map((r) => [r.id, r.rank]))
      );
    });
    this.prevRanks = this.currRanks;
    this.currRanks = next;
  }

  reloadPage() {
    window.location.reload();
  }

  /* ------------------------------------------------------------- bookings */

  subscribeToBookings() {
    try {
      onEmpError((err) => console.warn("[Sales Arena] booking stream", err));
      Promise.resolve(
        subscribe(BOOKING_CHANNEL, -1, (msg) => this.onBookingEvent(msg))
      ).catch((err) =>
        console.warn("[Sales Arena] booking subscribe failed", err)
      );
    } catch (err) {
      console.warn("[Sales Arena] booking subscribe failed", err);
    }
  }

  onBookingEvent(msg) {
    const p = (msg && msg.data && msg.data.payload) || {};
    this.enqueueBooking({
      opportunityId: p.Opportunity_Id__c,
      callerId: p.Caller_Id__c,
      callerName: p.Caller_Name__c,
      initials: p.Caller_Initials__c,
      photoUrl: p.Photo_Url__c,
      tlName: p.Tl_Name__c,
      zone: p.Zone__c,
      project: p.Project__c
    });
  }

  enqueueBooking(b) {
    if (!this.queue.push(b)) return;
    if (b.callerId)
      this.celebratedByCaller.set(
        b.callerId,
        (this.celebratedByCaller.get(b.callerId) || 0) + 1
      );
    // User.Zone__c is multi-select: "Chennai;Coimbatore" belongs to both zones.
    const zones = (b.zone || "")
      .split(";")
      .map((z) => z.trim())
      .filter(Boolean);
    const ownZone = zones.includes(this.zoneParam);
    if (ownZone) {
      this.zoneBookingsToday += 1;
      this.zoneBookingsMtd += 1;
    }
    b.countText = ownZone
      ? `Booking ${this.zoneBookingsToday} today in ${this.zoneParam}, ${this.zoneBookingsMtd} this month`
      : `Booked in ${zones.join(", ") || "another zone"}`;
  }

  /** Fallback when the event stream is down: a caller's booking count rose. */
  detectBookingsOnRefresh(people, firstLoad) {
    people.forEach((p) => {
      const count = Number(p.metrics.booking) || 0;
      const seen = this.celebratedByCaller.get(p.id) || 0;
      if (firstLoad) {
        this.celebratedByCaller.set(p.id, Math.max(count, seen));
        return;
      }
      for (let n = seen + 1; n <= count; n++) {
        this.enqueueBooking({
          opportunityId: `refresh-${p.id}-${this.dateKey}-${n}`,
          callerId: null,
          callerName: p.name,
          initials: p.initials,
          photoUrl: p.photoUrl,
          tlName: p.tlName,
          zone: this.zoneParam,
          project: null
        });
        this.celebratedByCaller.set(p.id, n);
      }
    });
  }

  /* ----------------------------------------------------------------- tick */

  tick() {
    this.nowMs = Date.now();
    const ist = istParts(this.nowMs);
    if (ist.dateKey !== this.dateKey) {
      this.dateKey = ist.dateKey;
      this.prevRanks = new Map();
      this.cycle = 0;
      this.sceneIndex = 0;
      this.sceneElapsed = 0;
      this.zoneBookingsToday = 0;
      this.celebratedByCaller = new Map();
    }
    if (shouldDailyReload(ist, this.lastReloadKey)) {
      this.lastReloadKey = ist.dateKey;
      this.reloadPage();
      return;
    }

    if (this.activeBooking) {
      this.takeoverLeft -= 1;
      if (this.takeoverLeft <= 0) this.activeBooking = null;
      return;
    }
    if (this.queue.size) {
      this.activeBooking = this.queue.next();
      this.takeoverLeft = TAKEOVER_SECONDS;
      return;
    }
    if (!this.data) return;

    const playlist = buildPlaylist(ist, this.cycle);
    if (this.sceneIndex >= playlist.length) this.sceneIndex = 0;
    this.sceneElapsed += 1;
    if (this.sceneElapsed >= playlist[this.sceneIndex].seconds) {
      this.sceneElapsed = 0;
      this.sceneIndex += 1;
      if (this.sceneIndex >= playlist.length) {
        this.sceneIndex = 0;
        this.cycle += 1;
      }
    }
  }

  /* ------------------------------------------------------------ view: hero */

  get ist() {
    return istParts(this.nowMs);
  }

  get isLoading() {
    return this.zoneConfigured && !this.data;
  }

  get isReady() {
    return this.zoneConfigured && Boolean(this.data);
  }

  get zoneName() {
    return `${this.zoneParam} Tele Arena`;
  }

  get clockText() {
    const { hour, minute } = this.ist;
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}:${String(minute).padStart(2, "0")}`;
  }

  get ampm() {
    return this.ist.hour < 12 ? "am" : "pm";
  }

  get dateText() {
    const ist = this.ist;
    const [y, m] = ist.dateKey.split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][
      ist.weekday - 1
    ];
    return `${wd} ${ist.dayOfMonth} ${ist.monthLabel}, day ${ist.dayOfMonth} of ${days}`;
  }

  get staleState() {
    return staleState(this.lastSuccessMs, this.nowMs);
  }

  get updatedText() {
    return updatedText(this.lastSuccessMs, this.nowMs);
  }

  label(key) {
    const def = ((this.data && this.data.metricDefs) || []).find(
      (d) => d.key === key
    );
    return (def && def.label) || FALLBACK_LABELS[key] || key;
  }

  unit(key) {
    const def = ((this.data && this.data.metricDefs) || []).find(
      (d) => d.key === key
    );
    return (def && def.unit) || "";
  }

  get heroTiles() {
    const d = this.data || {};
    const totals = d.totals || {};
    const mtd = d.mtdTotals || {};
    const base = d.baseline || {};
    const ist = this.ist;
    return HERO_KEYS.map((k) => ({
      key: k,
      label: `${this.label(k)} today`,
      today: Number(totals[k]) || 0,
      pace: paceState(
        Number(totals[k]) || 0,
        typicalByNow((base.hourly || {})[k], ist)
      ),
      mtd: Number(mtd[k]) || 0,
      mtdState: mtdState(
        Number(mtd[k]) || 0,
        (base.lastMonthToDate || {})[k],
        ist.prevMonthLabel
      )
    }));
  }

  /* ----------------------------------------------------------- view: scene */

  get playlist() {
    return buildPlaylist(this.ist, this.cycle);
  }

  get scene() {
    const pl = this.playlist;
    return pl[this.sceneIndex < pl.length ? this.sceneIndex : 0];
  }

  get sceneTitle() {
    const s = this.scene;
    if (s.kind === "top" || s.kind === "bottom") return this.label(s.metricKey);
    if (s.kind === "team") return "Team leaders";
    if (s.kind === "leaders") return "Managers and heads";
    return "Watchlist";
  }

  get sceneSubtitle() {
    const s = this.scene;
    if (s.kind === "top") return "Top 10 today";
    if (s.kind === "bottom") return "Bottom 5, available callers";
    if (s.kind === "watchlist") {
      const n = ((this.data && this.data.settings) || {}).watchlistMinWeak || 3;
      return `Below the zone average on ${n} or more measures`;
    }
    return `Today in ${this.zoneParam}`;
  }

  get isBoardScene() {
    return this.scene.kind === "top" || this.scene.kind === "bottom";
  }

  get isTeamScene() {
    return this.scene.kind === "team" || this.scene.kind === "leaders";
  }

  get isWatchlistScene() {
    return this.scene.kind === "watchlist";
  }

  get boardVariant() {
    return this.scene.kind;
  }

  get boardUnit() {
    return this.unit(this.scene.metricKey);
  }

  get boardRows() {
    const s = this.scene;
    if (s.kind === "bottom") return bottomRows(this.people, s.metricKey);
    return applyMovement(
      topRows(this.people, s.metricKey),
      this.prevRanks,
      `${s.metricKey}-top`
    );
  }

  get showPace() {
    return this.scene.kind === "team";
  }

  get teamTableRows() {
    const d = this.data || {};
    if (this.scene.kind === "leaders") {
      return [
        ...teamRows(this.people, "manager"),
        ...teamRows(this.people, "head")
      ];
    }
    const ist = this.ist;
    const tlHourly = (d.baseline && d.baseline.tlHourly) || {};
    const tlPace = {};
    Object.keys(tlHourly).forEach((tlId) => {
      const today = this.people
        .filter((p) => p.tlId === tlId)
        .reduce((s, p) => s + (Number(p.metrics.svConducted) || 0), 0);
      tlPace[tlId] = paceState(today, typicalByNow(tlHourly[tlId], ist));
    });
    return teamRows(this.people, "tl", {
      tlTeamSizes: d.tlTeamSizes || {},
      tlPace
    });
  }

  get watchRows() {
    const d = this.data || {};
    return watchlistRows(this.people, d.metricDefs || [], d.settings || {});
  }

  get progressDots() {
    return this.playlist.map((s, i) => ({
      key: s.id,
      cls: i <= this.sceneIndex ? "dot on" : "dot"
    }));
  }

  get progressStyle() {
    const pct = Math.min(100, (this.sceneElapsed / this.scene.seconds) * 100);
    return `width:${pct}%`;
  }

  /* -------------------------------------------------------- view: TV chrome */

  get tvClass() {
    return isDimmed(this.ist) ? "tv dim" : "tv";
  }

  get screenStyle() {
    const o = burnInOffset(this.nowMs);
    return `transform:translate(${o.x}px,${o.y}px)`;
  }

  get raceEntries() {
    return (this.data && this.data.zoneRace) || [];
  }
}
