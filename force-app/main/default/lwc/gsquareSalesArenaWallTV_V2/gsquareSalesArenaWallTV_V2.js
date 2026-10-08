import { LightningElement, api, wire } from "lwc";
import { refreshApex } from "@salesforce/apex";
import getDashboard from "@salesforce/apex/GSquareSalesArenaControllerWallTV_V2.getDashboard";
import { subscribe, onError as onEmpError } from "lightning/empApi";
import getZoneGroups from "@salesforce/apex/GSquareSalesArenaControllerWallTV_V2.getZoneGroups";
import {
  istParts,
  typicalByNow,
  paceState,
  mtdState,
  buildPlaylist,
  pageCount,
  pageIndexAt,
  pageRows,
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
// Each TV's browser remembers its zone across the daily 08:30 reload.
const ZONE_STORAGE_KEY = "gsquareArenaTv.zone";
const ZOOM_STORAGE_KEY = "gsquareArenaTv.zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;
// Salesforce's utility bar (softphone, Omni-Channel) sits over the bottom of
// the tab and is outside this component, so leave room for it.
const FIT_BOTTOM_GAP_PX = 48;
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
 * Sales Arena zone TV wall. One tab serves every zone: the zone picker in the
 * top-right corner chooses it (remembered per browser), or a Lightning page
 * can preset the `zone` property. All rules live in c/gsquareArenaLogic; this
 * class owns the wire, the timers and the booking-event subscription. The
 * zone picker is the only control on the wall.
 */
export default class GsquareSalesArena extends LightningElement {
  @api zone;

  selectedZone;
  zoneOptions = [];

  fitWidth = 0; // px: the space visible under the Salesforce header
  fitHeight = 0;
  zoom = 1;
  // CSS "expanded" mode, as on the Caller Performance tab. The browser
  // Fullscreen API is blocked by Lightning Web Security, so it is never touched.
  isExpanded = false;
  boundMeasure = () => this.measure();
  boundKeydown = (e) => {
    if (e.key === "Escape" && this.isExpanded) this.toggleExpanded();
  };

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
    this.selectedZone = this.readStoredZone();
    this.zoom = this.readStoredZoom();
    this.subscribeToBookings();
    window.addEventListener("resize", this.boundMeasure);
    window.addEventListener("keydown", this.boundKeydown);
  }

  disconnectedCallback() {
    clearInterval(this.tickTimer);
    clearInterval(this.refreshTimer);
    window.removeEventListener("resize", this.boundMeasure);
    window.removeEventListener("keydown", this.boundKeydown);
  }

  renderedCallback() {
    // cheap, and catches Salesforce header/layout changes as well as resizes
    this.measure();
  }

  /* ------------------------------------------------------- fit and zoom */

  /**
   * Fills the space actually visible: the whole tab below the Salesforce
   * header (like the Caller Performance tab), or the whole window when expanded.
   */
  measure() {
    const fit = this.refs && this.refs.fit;
    if (!fit) return;
    const rect = fit.getBoundingClientRect();
    const w = Math.floor(this.isExpanded ? window.innerWidth : rect.width);
    const h = Math.floor(
      this.isExpanded
        ? window.innerHeight
        : window.innerHeight - Math.max(rect.top, 0) - FIT_BOTTOM_GAP_PX
    );
    if (w > 0 && w !== this.fitWidth) this.fitWidth = w;
    if (h > 0 && h !== this.fitHeight) this.fitHeight = h;
  }

  get tvStyle() {
    if (!this.fitWidth || !this.fitHeight) return "";
    return `width:${Math.round(this.fitWidth * this.zoom)}px;height:${Math.round(this.fitHeight * this.zoom)}px`;
  }

  get fitClass() {
    return this.isExpanded ? "fit expanded" : "fit";
  }

  get zoomLabel() {
    return `${Math.round(this.zoom * 100)}%`;
  }

  zoomIn() {
    this.setZoom(this.zoom + ZOOM_STEP);
  }

  zoomOut() {
    this.setZoom(this.zoom - ZOOM_STEP);
  }

  zoomFit() {
    this.setZoom(1);
  }

  setZoom(z) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    this.zoom = Math.round(clamped * 10) / 10;
    try {
      window.localStorage.setItem(ZOOM_STORAGE_KEY, String(this.zoom));
    } catch (e) {
      // storage blocked: zoom lasts until the next reload
    }
  }

  readStoredZoom() {
    try {
      const z = parseFloat(window.localStorage.getItem(ZOOM_STORAGE_KEY));
      return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
    } catch (e) {
      return 1;
    }
  }

  get expandTitle() {
    return this.isExpanded ? "Exit full screen (Esc)" : "Full screen";
  }

  toggleExpanded() {
    this.isExpanded = !this.isExpanded;
    // re-measure after the class change has rendered
    Promise.resolve().then(() => this.measure());
  }

  /** The picker's choice wins over a Lightning page's preset zone. */
  get zoneParam() {
    const pick = (z) => (typeof z === "string" ? z.trim() : "");
    return pick(this.selectedZone) || pick(this.zone) || undefined;
  }

  get zoneConfigured() {
    return Boolean(this.zoneParam);
  }

  /* ----------------------------------------------------------- zone picker */

  // Telecaller seating groups (Chennai, Coimbatore, Pune, Others), defined
  // once in GSquareSalesArenaWrapperWallTV_V2.ZONE_GROUPS.
  @wire(getZoneGroups)
  wiredZones({ data, error }) {
    if (data) this.zoneOptions = data;
    else if (error) console.warn("[Sales Arena] zone list failed", error);
  }

  get zoneChoices() {
    return this.zoneOptions.map((z) => ({
      value: z,
      selected: z === this.zoneParam
    }));
  }

  get noZoneSelected() {
    return !this.zoneParam;
  }

  get showZonePicker() {
    return !this.activeBooking;
  }

  handleZoneChange(event) {
    const z = event.target.value;
    if (!z || z === this.zoneParam) return;
    this.selectedZone = z;
    this.storeZone(z);
    this.resetForZone();
  }

  /** Nothing from the previous zone carries over; the wire reloads for the new one. */
  resetForZone() {
    clearInterval(this.refreshTimer);
    this.data = undefined;
    this.wiredResult = undefined;
    this.people = [];
    this.prevRanks = new Map();
    this.currRanks = new Map();
    this.queue = new TakeoverQueue();
    this.activeBooking = null;
    this.celebratedByCaller = new Map();
    this.zoneBookingsToday = 0;
    this.zoneBookingsMtd = 0;
    this.cycle = 0;
    this.sceneIndex = 0;
    this.sceneElapsed = 0;
  }

  readStoredZone() {
    try {
      return window.localStorage.getItem(ZONE_STORAGE_KEY) || undefined;
    } catch (e) {
      return undefined;
    }
  }

  storeZone(z) {
    try {
      window.localStorage.setItem(ZONE_STORAGE_KEY, z);
    } catch (e) {
      // storage blocked: the choice lasts until the next reload
    }
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
    // a remembered or preset raw zone ("Hosur") comes back as its group
    // ("Coimbatore"): adopt it so the picker and the title show the group
    if (data.zone && data.zone !== this.zoneParam) {
      this.selectedZone = data.zone;
      this.storeZone(data.zone);
    }
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
    if (!this.zoneParam) return; // no zone chosen yet: nothing on screen to celebrate
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

    const playlist = buildPlaylist(ist, this.cycle, this.teamPageCounts);
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
    return buildPlaylist(this.ist, this.cycle, this.teamPageCounts);
  }

  get teamPageCounts() {
    return {
      teamPages: pageCount(this.tlRows.length),
      leaderPages: pageCount(this.leaderRows.length)
    };
  }

  /** Which page of the current team table is on screen, and of how many. */
  get teamPage() {
    const s = this.scene;
    const rows = s.kind === "leaders" ? this.leaderRows : this.tlRows;
    const pages = pageCount(rows.length);
    return {
      rows,
      pages,
      index: pageIndexAt(this.sceneElapsed, s.seconds, pages)
    };
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
    const { rows, pages, index } = this.teamPage;
    const n = rows.length;
    const count =
      s.kind === "leaders"
        ? `${n} ${n === 1 ? "person" : "people"}`
        : `${n} ${n === 1 ? "TL" : "TLs"}`;
    const parts = [`Today in ${this.zoneParam}`, count];
    if (pages > 1) parts.push(`page ${index + 1} of ${pages}`);
    return parts.join(" · ");
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
    const { rows, index } = this.teamPage;
    return pageRows(rows, index);
  }

  get leaderRows() {
    return [
      ...teamRows(this.people, "manager"),
      ...teamRows(this.people, "head")
    ];
  }

  get tlRows() {
    const d = this.data || {};
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
