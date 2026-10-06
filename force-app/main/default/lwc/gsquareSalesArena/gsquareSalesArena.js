import { LightningElement, wire, track } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import getDashboard from '@salesforce/apex/GSquareSalesArenaController.getDashboard';

/**
 * Sales Arena container.
 *
 * Holds NO Salesforce field API names. Everything derives from the metricDefs and
 * settings supplied by Apex (generated from SalesArenaConfig.cls), so remapping a
 * field never requires a change in this file.
 *
 * PERFORMANCE NOTE
 * ----------------
 * The rotation timer fires 10x/second. Leaderboards are therefore computed into a
 * cached @track array ONLY when tier / mode / data actually change -- never from a
 * template getter, which would re-rank 365 people x 6 metrics ten times a second
 * for an entire shift. The countdown bar is written straight to the DOM for the
 * same reason: it must not trigger a reactive re-render.
 */

/* =============================================================================
   INLINED FROM metricEngineLib.js
   ---------------------------------------------------------------------------
   Consolidated into this single LWC bundle per the requested structure (one
   gsquareSalesArena component, not three separate bundles). Nothing below
   references a Salesforce field API name -- every function is driven by the
   metricDefs array supplied by Apex (generated from GSquareSalesArenaWrapper),
   so remapping a field in Apex changes these numbers with zero edits here.
============================================================================ */

/**
 * =============================================================================
 *  metricEngine.js -- shared calculation layer for every Sales Arena component
 * =============================================================================
 *  NOTHING IN THIS FILE REFERENCES A SALESFORCE FIELD API NAME.
 *
 *  Every function is driven by the metricDefs array supplied by Apex, which is
 *  itself generated from SalesArenaConfig. Remapping a field in Apex changes the
 *  numbers here with zero JS edits.
 *
 *  Consumed by: funnel strip, leaderboards, alerts, watchlist, both overlays.
 * =============================================================================
 */

const TIER = {
    INDIVIDUAL: 'individual',
    TEAM: 'team',
    TL: 'tl',
    MANAGER: 'manager',
    HEAD: 'head'
};

/** Hierarchy field on PersonDTO for a given tier. */
const TIER_GROUP_FIELD = {
    [TIER.TL]: 'tlName',
    [TIER.MANAGER]: 'managerName',
    [TIER.HEAD]: 'headName'
};

/** Real Salesforce Id field paired with each tier's display-name field. */
const TIER_ID_FIELD = {
    [TIER.TL]: 'tlId',
    [TIER.MANAGER]: 'managerId',
    [TIER.HEAD]: 'headId'
};

const UNASSIGNED = 'Unassigned';

/* -------------------------------------------------------------------------
 * Config helpers
 * ---------------------------------------------------------------------- */
function orderedMetrics(metricDefs) {
    return [...metricDefs].sort((a, b) => a.displayOrder - b.displayOrder);
}

function boardMetrics(metricDefs) {
    return orderedMetrics(metricDefs).filter((m) => m.showInBoards);
}

function funnelMetrics(metricDefs) {
    return orderedMetrics(metricDefs).filter((m) => m.showInFunnel);
}

function findMetric(metricDefs, key) {
    return metricDefs.find((m) => m.key === key);
}

/* -------------------------------------------------------------------------
 * Rate derivation -- applied wherever a group is built
 * ---------------------------------------------------------------------- */
function applyRates(row, metricDefs) {
    metricDefs
        .filter((m) => m.isRate)
        .forEach((m) => {
            const num = row.metrics[m.numeratorKey] || 0;
            const den = row.metrics[m.denominatorKey] || 0;
            row.metrics[m.key] = den > 0 ? (num / den) * 100 : 0;
        });
    return row;
}

/* -------------------------------------------------------------------------
 * Aggregation
 * ---------------------------------------------------------------------- */

/**
 * Build ranking rows for a tier.
 * @param tier one of TIER.*
 * @param teamTlName required when tier === TIER.TEAM (which TL's roster to show)
 */
/**
 * Build ranking rows for a tier.
 * @param tier one of TIER.*
 * @param teamTlId required when tier === TIER.TEAM (the specific TL's real
 *   Salesforce Id whose roster to show -- NOT their display name. Two
 *   different TLs sharing an identical Name is possible at 300+ users;
 *   filtering on name would silently combine both real teams' rosters into
 *   one Team Spotlight view.)
 * @param opts.includeUnassigned  Competitive leaderboards must NOT include the
 *   synthetic "Unassigned" bucket -- it is not a real team and must never rank,
 *   never become Dominant Team, and never drill into fake sub-managers (audit
 *   finding #2). Callers that need a true floor-wide total (which legitimately
 *   includes every valid activity record, mapped or not) pass
 *   { includeUnassigned: true } explicitly rather than this being the default.
 */
function aggregate(people, metricDefs, tier, teamTlId, opts = {}) {
    const includeUnassigned = opts.includeUnassigned === true;

    if (tier === TIER.INDIVIDUAL) {
        return people.map((p) =>
            applyRates({ name: p.name, id: p.userId, metrics: { ...p.metrics } }, metricDefs)
        );
    }

    if (tier === TIER.TEAM) {
        return people
            .filter((p) => p.tlId === teamTlId)
            .map((p) =>
                applyRates({ name: p.name, id: p.userId, metrics: { ...p.metrics } }, metricDefs)
            );
    }

    const field = TIER_GROUP_FIELD[tier];
    const idField = TIER_ID_FIELD[tier];
    const groups = {};
    people.forEach((p) => {
        const name = p[field] || UNASSIGNED;
        if (name === UNASSIGNED && !includeUnassigned) return; // never a competitive "team"
        // Group by the REAL Salesforce Id, not by display name. Grouping by name
        // was the actual root cause behind audit finding #16: two different TLs
        // sharing an identical Name were being silently merged into one combined
        // row (each contributing to the same totals) rather than producing two
        // separate, correctly-attributed rows. Id collisions do not happen;
        // name collisions do. UNASSIGNED has no meaningful Id, so it still groups
        // on the literal string (there is exactly one such bucket by design).
        const groupKey = name === UNASSIGNED ? UNASSIGNED : p[idField] || name;
        if (!groups[groupKey]) {
            groups[groupKey] = { name, id: groupKey, realId: groupKey, count: 0, subs: new Set(), metrics: {} };
        }
        const g = groupKey;
        groups[g].count += 1;
        if (tier === TIER.HEAD && p.managerName !== UNASSIGNED) groups[g].subs.add(p.managerName);
        if (tier === TIER.MANAGER && p.tlName !== UNASSIGNED) groups[g].subs.add(p.tlName);
        metricDefs
            .filter((m) => !m.isRate)
            .forEach((m) => {
                groups[g].metrics[m.key] = (groups[g].metrics[m.key] || 0) + (p.metrics[m.key] || 0);
            });
    });

    return Object.values(groups).map((g) => {
        g.subCount = g.subs.size;
        delete g.subs;
        return applyRates(g, metricDefs);
    });
}

/**
 * True floor-wide totals -- deliberately separate from aggregate() so a caller
 * cannot accidentally get Unassigned-inflated "team" numbers while still being
 * able to get a correct grand total that legitimately includes every person,
 * mapped or not (audit finding #2: don't silently drop real activity data,
 * only keep it out of competitive rankings).
 */
function floorTotals(people, metricDefs) {
    const totals = {};
    metricDefs.filter((m) => !m.isRate).forEach((m) => {
        totals[m.key] = people.reduce((s, p) => s + (p.metrics[m.key] || 0), 0);
    });
    metricDefs.filter((m) => m.isRate).forEach((m) => {
        const num = totals[m.numeratorKey] || 0;
        const den = totals[m.denominatorKey] || 0;
        totals[m.key] = den > 0 ? (num / den) * 100 : 0;
    });
    return totals;
}


/** Per-caller averages -- used by the Manager and Head overlays. */
function averages(people, metricDefs, tier) {
    return aggregate(people, metricDefs, tier).map((g) => {
        const out = { name: g.name, realId: g.realId, count: g.count, subCount: g.subCount, metrics: {} };
        metricDefs.forEach((m) => {
            // Rates must NOT be averaged -- recompute from pooled totals
            out.metrics[m.key] = m.isRate ? g.metrics[m.key] : (g.metrics[m.key] || 0) / g.count;
        });
        // Raw (non-averaged) values kept for low-volume metrics like bookings
        out.raw = { ...g.metrics };
        return out;
    });
}

/* -------------------------------------------------------------------------
 * Ranking
 * ---------------------------------------------------------------------- */

/** Rate metrics need a minimum denominator or 1-of-1 = 100% tops the board. */
function qualifiedPool(rows, metric, tier) {
    if (!metric.isRate) return rows;
    const min = (metric.minVolumeByTier && metric.minVolumeByTier[tier]) || 5;
    return rows.filter((r) => (r.metrics[metric.denominatorKey] || 0) >= min);
}

function minVolumeFor(metric, tier) {
    if (!metric.isRate) return null;
    return (metric.minVolumeByTier && metric.minVolumeByTier[tier]) || 5;
}

function rank(rows, metric, { tier, limit = 10, direction = 'top' } = {}) {
    const pool = qualifiedPool(rows, metric, tier).filter((r) => (r.metrics[metric.key] || 0) > 0);
    const sorted = [...pool].sort((a, b) =>
        direction === 'bottom'
            ? a.metrics[metric.key] - b.metrics[metric.key]
            : b.metrics[metric.key] - a.metrics[metric.key]
    );
    return sorted.slice(0, limit).map((r, idx, arr) => decorate(r, idx, arr, metric));
}

/** Adds rank, display value, bar width and gap-to-next-rank. */
function decorate(row, idx, arr, metric) {
    const value = row.metrics[metric.key] || 0;
    const top = arr[0] ? arr[0].metrics[metric.key] : 1;
    const prev = idx > 0 ? arr[idx - 1].metrics[metric.key] : null;
    const gapRaw = prev === null ? null : prev - value;

    return {
        key: `${metric.key}-${row.realId || row.id}`,
        name: row.name,
        rank: idx + 1,
        rankClass: idx === 0 ? 'row r1' : idx === 1 ? 'row r2' : idx === 2 ? 'row r3' : 'row',
        value: formatValue(value, metric),
        barStyle: `width:${Math.max(6, Math.min(100, top > 0 ? (value / top) * 100 : 0))}%`,
        isLead: idx === 0,
        gap: gapRaw === null ? 'LEAD' : gapRaw > 0 ? `-${roundGap(gapRaw, metric)}` : '=',
        gapClass: gapRaw !== null && gapRaw <= closeThreshold(metric) ? 'rgap close' : 'rgap',
        // Rate rows expose the underlying counts so the ratio is auditable
        subLabel: metric.isRate
            ? `${fmtNum(row.metrics[metric.numeratorKey])}/${fmtNum(row.metrics[metric.denominatorKey])}`
            : null
    };
}

function closeThreshold(metric) {
    if (metric.isRate) return 2;
    if (metric.unit === 'min') return 5;
    return 1;
}

function roundGap(g, metric) {
    return metric.isRate || metric.unit === 'min' ? Math.round(g) : g;
}

function fmtNum(v) {
    return Math.round(v || 0);
}

function formatValue(v, metric) {
    if (metric.isRate) return `${Math.round(v)}`;
    if (metric.unit === 'min') return `${Math.round(v)}`;
    return `${v}`;
}

/* -------------------------------------------------------------------------
 * Insights (top performer per metric)
 * ---------------------------------------------------------------------- */
function insights(people, metricDefs, keys) {
    const rows = aggregate(people, metricDefs, TIER.INDIVIDUAL);
    return keys
        .map((k) => findMetric(metricDefs, k))
        .filter(Boolean)
        .map((m) => {
            const top = rank(rows, m, { tier: TIER.INDIVIDUAL, limit: 1 })[0];
            return {
                key: m.key,
                label: `Most ${m.label}`,
                icon: m.icon,
                name: top ? top.name : '\u2014',
                metric: top ? `${top.value}${m.unit}` : '\u2014'
            };
        });
}

/* -------------------------------------------------------------------------
 * Dominant Team (audit finding #10)
 *
 * This existed in the approved HTML prototype (a banner showing which TL leads
 * the most board metrics) but was not carried over when the LWC was built --
 * an unintentional omission, not a scope decision, confirmed by grep across
 * the whole LWC/Apex tree finding zero references. Restored here operating on
 * the SAME Unassigned-excluded rows aggregate() now produces by default, so
 * "Unassigned" can never win Dominant Team.
 * ---------------------------------------------------------------------- */
function dominantTeam(rows, metricDefs) {
    if (!rows.length) return null;
    const boardable = boardMetrics(metricDefs);
    const wins = {};
    boardable.forEach((m) => {
        const top = rank(rows, m, { tier: TIER.TL, limit: 1 })[0];
        if (top) wins[top.name] = (wins[top.name] || 0) + 1;
    });
    const names = Object.keys(wins);
    if (!names.length) return null;
    names.sort((a, b) => wins[b] - wins[a]);
    return { name: names[0], metricsWon: wins[names[0]], totalMetrics: boardable.length };
}

/* -------------------------------------------------------------------------
 * Watchlist / alerts
 * ---------------------------------------------------------------------- */
function watchlist(people, metricDefs, settings) {
    const mapped = people.filter((p) => p.tlName !== UNASSIGNED);
    if (!mapped.length) return [];

    const scored = metricDefs.filter((m) => !m.isRate);
    const avg = {};
    scored.forEach((m) => {
        avg[m.key] = mapped.reduce((s, p) => s + (p.metrics[m.key] || 0), 0) / mapped.length;
    });

    const out = [];
    mapped.forEach((p) => {
        const reasons = scored
            .filter((m) => (p.metrics[m.key] || 0) < avg[m.key])
            .map((m) => ({
                metric: m.label,
                value: Math.round(p.metrics[m.key] || 0),
                isZero: (p.metrics[m.key] || 0) === 0
            }));
        if (reasons.length >= settings.watchlistMinWeak) {
            const zeros = reasons.filter((r) => r.isZero).length;
            out.push({
                name: p.name,
                reasons,
                zeros,
                severity: zeros >= settings.alertCriticalZeroCount ? 'critical' : 'important'
            });
        }
    });

    // Worst first, then capped so this stays an exception report not a census
    out.sort((a, b) => b.zeros - a.zeros || b.reasons.length - a.reasons.length);
    return out.slice(0, settings.watchlistMaxEntries);
}

function buildAlertQueue(people, metricDefs, settings) {
    const negatives = watchlist(people, metricDefs, settings).map((w) => ({
        type: 'negative',
        severity: w.severity,
        name: w.name,
        zeros: w.zeros,
        reasons: w.reasons
    }));

    const rows = aggregate(people, metricDefs, TIER.INDIVIDUAL);
    const positives = orderedMetrics(metricDefs)
        .map((m) => {
            const top = rank(rows, m, { tier: TIER.INDIVIDUAL, limit: 1 })[0];
            return top
                ? { type: 'positive', name: top.name, label: `Top ${m.label}`, value: `${top.value}${m.unit}`, icon: m.icon }
                : null;
        })
        .filter(Boolean);

    // Interleave a positive every third alert so the wall is not only bad news
    const merged = [];
    let p = 0;
    negatives.forEach((n, i) => {
        merged.push(n);
        if ((i + 1) % 3 === 0 && positives.length) merged.push(positives[p++ % positives.length]);
    });
    if (!merged.length) merged.push(...positives);
    if (!merged.length) merged.push({ type: 'positive', allClear: true, name: 'All Clear' });
    return merged;
}

export default class GsquareSalesArena extends LightningElement {
    @track data;
    @track error;
    @track loading = true;
    @track isStale = false;
    @track staleSinceText = '';

    // cached view models -- recomputed only on real change
    @track boards = [];
    @track funnelCards = [];
    @track funnelLinks = [];
    @track insightCards = [];

    wiredResult;

    // rotation state (plain fields, intentionally not reactive)
    tiers = [TIER.INDIVIDUAL, TIER.TL, TIER.TEAM];
    tierIdx = 0;
    tierElapsed = 0;
    tickCount = 0; // integer 100ms-tick counter; see tick() for why this replaced float accumulation
    boardMode = 'top';
    teamCursor = 0;

    @track currentTeamTl = null;    // display name, for the header only
    currentTeamId = null;           // real Salesforce Id -- this is what filtering uses
    @track tierLabel = 'FLOOR LEADERBOARD';
    @track isTeamTier = false;
    @track teamMeta = null;

    // alert state
    alertQueue = [];
    alertIdx = 0;
    @track activeAlert = null;
    @track alertVisible = false;

    // overlay state
    @track overlayLevel = null;
    @track overlayVisible = false;
    overlayQueue = [];
    overlayTimer = null;
    overlayChainTimer = null;
    alertAnimTimer = null;

    @track clockText = '--:--:--';
    timers = [];
    timersStarted = false;

    /* ================================================================== */
    @wire(getDashboard)
    wiredDashboard(result) {
        this.wiredResult = result;
        const { data, error } = result;
        if (data) {
            this.data = data;
            this.error = undefined;
            this.isStale = false;
            this.loading = false;
            this.onDataChanged();
        } else if (error) {
            if (this.data) {
                // FIX (audit finding #1): a refresh failure after a successful load
                // must NOT blank the wall. `error` and `data` were previously
                // independent if:true template blocks, so setting `error` here left
                // the full dashboard AND an "unavailable" banner rendered at the
                // same time. With existing data, we keep serving it and raise only
                // a subtle stale-data indicator; `error` stays unset so the
                // full-screen error template never shows over live data.
                this.isStale = true;
                this.staleSinceText = this.lastUpdatedText;
            } else {
                // No prior data exists (this is the first load) -- a full-screen
                // error state is the correct, only reasonable thing to show.
                this.error = error.body ? error.body.message : error.message;
            }
            this.loading = false;
        }
    }

    connectedCallback() {
        this.updateClock();
        this.timers.push(setInterval(() => this.updateClock(), 1000));
    }

    disconnectedCallback() {
        this.timers.forEach((t) => clearInterval(t));
        this.timers = [];
        if (this.overlayTimer) clearTimeout(this.overlayTimer);
        if (this.overlayChainTimer) clearTimeout(this.overlayChainTimer);
        if (this.alertAnimTimer) clearTimeout(this.alertAnimTimer);
    }

    /* ---------------- data-driven rebuild ---------------- */
    onDataChanged() {
        const s = this.settings;
        this.alertQueue = buildAlertQueue(this.data.people, this.data.metricDefs, s);

        // FIX (audit finding #13, plus a related bug found on review): if a TL
        // is deactivated/reassigned between refreshes, a stale reference would
        // keep matching zero people -- re-validated on every refresh, not just
        // first load. Tracks the real Id (teamRoster[].tlId), not the display
        // name -- two different TLs can share an identical Name, and matching
        // on name would silently combine both real teams' rosters into one
        // Team Spotlight view (the same root-cause bug fixed in
        // metricEngineLib.js's aggregate(), found in a second location here).
        const roster = this.data.teamRoster || [];
        const stillValid = roster.find((r) => r.tlId === this.currentTeamId);
        if (!roster.length) {
            this.currentTeamId = null;
            this.currentTeamTl = null;
        } else if (!stillValid) {
            const entry = roster[this.teamCursor % roster.length] || roster[0];
            this.currentTeamId = entry.tlId;
            this.currentTeamTl = entry.tlName;
        }

        this.buildStatic();
        this.buildBoards();
        this.startTimers();
    }

    buildStatic() {
        const defs = this.data.metricDefs;

        this.funnelCards = funnelMetrics(defs).map((m) => ({
            key: m.key,
            label: m.label,
            value: this.formatTotal(m),
            cssClass: `kpi-card accent-${m.key}`
        }));

        this.funnelLinks = defs
            .filter((m) => m.isRate)
            .map((m) => {
                const pct = this.data.totals[m.key] || 0;
                return {
                    key: m.key,
                    pct: `${pct}%`,
                    // FIX (audit finding #11): this percentage and the leaderboard
                    // board's header percentage are DIFFERENT, real business
                    // definitions -- this one is server-computed from ALL floor
                    // activity (no minimum-volume qualifier), while the board
                    // total (see boardTotal() below) only pools rows meeting the
                    // tier's minimum volume, specifically to keep a 1-of-1=100%
                    // outlier from topping the leaderboard. Collapsing them to
                    // agree would either reintroduce that noise into the board or
                    // remove the true floor-wide number from the strip. Labelled
                    // distinctly instead, per the audit's own recommendation.
                    label: `${m.label} (Floor)`,
                    cssClass:
                        pct < (this.settings.rateBadThreshold || 12)
                            ? 'funnel-link weak'
                            : 'funnel-link'
                };
            });

        const keys = orderedMetrics(defs)
            .filter((m) => m.showInFunnel)
            .map((m) => m.key);
        this.insightCards = insights(this.data.people, defs, keys);
    }

    /** Recomputed only when tier, mode, team or data changes. */
    buildBoards() {
        if (!this.data) return;
        const tier = this.currentTier;
        const rows = aggregate(this.data.people, this.data.metricDefs, tier, this.currentTeamId);
        const limit = tier === TIER.TEAM ? 99 : this.settings.boardRowLimit || 10;

        this.boards = boardMetrics(this.data.metricDefs).map((m) => {
            const ranked = rank(rows, m, { tier, limit, direction: this.boardMode });
            const minVol = minVolumeFor(m, tier);
            return {
                key: m.key,
                // "(Qualified)" pairs with the funnel strip's "(Floor)" label
                // (audit finding #11) so the two intentionally-different
                // percentages are never mistaken for a bug.
                label: m.isRate ? `${m.label} (Qualified)` : m.label,
                qualifier: minVol ? `min ${minVol}` : null,
                total: this.boardTotal(m, rows),
                rows: ranked,
                hasRows: ranked.length > 0,
                emptyText: m.isRate ? `Below ${minVol} scheduled` : 'No activity yet',
                cssClass: `board metric-${m.key} mode-${this.boardMode}`
            };
        });

        this.tierLabel =
            tier === TIER.TEAM
                ? 'TEAM SPOTLIGHT'
                : tier === TIER.TL
                ? 'TEAM LEADER LEADERBOARD'
                : 'FLOOR LEADERBOARD';
        this.isTeamTier = tier === TIER.TEAM;
        this.teamMeta = this.isTeamTier ? this.computeTeamMeta() : null;
    }

    computeTeamMeta() {
        const size = this.data.people.filter((p) => p.tlId === this.currentTeamId).length;
        const total = (this.data.teamRoster || []).length;
        const pos = total ? ((this.teamCursor - 1 + total) % total) + 1 : 0;
        return `${size} callers \u00B7 ${pos}/${total}`;
    }

    /* ---------------- timers ---------------- */
    startTimers() {
        if (this.timersStarted) return;
        this.timersStarted = true;
        const s = this.settings;

        this.timers.push(setInterval(() => this.tick(), 100));

        this.nextAlert();
        this.timers.push(setInterval(() => this.nextAlert(), (s.alertHoldSeconds || 7) * 1000));

        // Scheduled overlays: Manager every 20 min, Head every 30 min.
        // They collide hourly; the second is queued, not dropped.
        this.timers.push(
            setInterval(() => this.openOverlay('manager'), (s.overlayManagerMinutes || 20) * 60000)
        );
        this.timers.push(
            setInterval(() => this.openOverlay('head'), (s.overlayHeadMinutes || 30) * 60000)
        );

        this.timers.push(
            setInterval(() => refreshApex(this.wiredResult), (s.refreshSeconds || 180) * 1000)
        );
    }

    /**
     * Rotation tick. Writes the countdown bar imperatively so it never triggers a
     * reactive re-render; only a genuine tier/mode change rebuilds the boards.
     */
    /**
     * Rotation tick. Writes the countdown bar imperatively so it never triggers a
     * reactive re-render; only a genuine tier/mode change rebuilds the boards.
     *
     * Uses an INTEGER 100ms tick counter rather than accumulating a float
     * (`tierElapsed += 0.1`). Discovered via an actual Jest run of the test
     * suite added for audit finding #1: floating-point drift means 100
     * accumulations of 0.1 lands on 9.99999999999998, not 10 -- so
     * `tierElapsed >= tierSeconds` was never true and the tier would silently
     * fail to rotate on schedule (drifting later by roughly one 100ms tick
     * every cycle). Not in the original audit; found only by executing the
     * test, not by reading the code.
     */
    tick() {
        const s = this.settings;
        const tierSeconds = s.tierSeconds || 10;
        this.tickCount += 1;
        this.tierElapsed = this.tickCount / 10; // integer/10 -- no float accumulation drift

        const bar = this.template.querySelector('.tier-timer-fill');
        if (bar) {
            bar.style.width = `${Math.min(100, (this.tierElapsed / tierSeconds) * 100)}%`;
        }

        let dirty = false;

        if (this.currentTier !== TIER.TEAM) {
            const target = this.tierElapsed < (s.modeFlipSeconds || 5) ? 'top' : 'bottom';
            if (target !== this.boardMode) {
                this.boardMode = target;
                dirty = true;
            }
        }

        if (this.tickCount >= tierSeconds * 10) {
            this.tickCount = 0;
            this.tierElapsed = 0;
            this.tierIdx = (this.tierIdx + 1) % this.tiers.length;
            this.boardMode = 'top';
            if (this.currentTier === TIER.TEAM) {
                const roster = this.data.teamRoster || [];
                if (roster.length) {
                    const entry = roster[this.teamCursor % roster.length];
                    this.currentTeamId = entry.tlId;
                    this.currentTeamTl = entry.tlName;
                    this.teamCursor += 1;
                }
            }
            dirty = true;
        }

        if (dirty) this.buildBoards();
    }

    /* ---------------- alerts ---------------- */
    nextAlert() {
        if (!this.alertQueue.length) return;
        // brief hide so the entrance animation replays for each alert
        this.alertVisible = false;
        // FIX (audit finding #12): this handle was previously untracked, so a
        // component teardown during the 400ms window left a pending callback
        // that could still fire against a disconnected instance.
        if (this.alertAnimTimer) clearTimeout(this.alertAnimTimer);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.alertAnimTimer = setTimeout(() => {
            this.activeAlert = this.alertQueue[this.alertIdx % this.alertQueue.length];
            this.alertIdx += 1;
            this.alertVisible = true;
        }, 400);
    }

    /* ---------------- overlays ---------------- */
    openOverlay(level) {
        if (this.overlayVisible) {
            if (!this.overlayQueue.includes(level)) this.overlayQueue.push(level);
            return;
        }
        this.overlayLevel = level;
        this.overlayVisible = true;
        if (this.overlayTimer) clearTimeout(this.overlayTimer);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this.overlayTimer = setTimeout(
            () => this.closeOverlay(),
            (this.settings.overlayHoldSeconds || 25) * 1000
        );
    }

    closeOverlay() {
        this.overlayVisible = false;
        if (this.overlayTimer) clearTimeout(this.overlayTimer);
        if (this.overlayQueue.length) {
            const next = this.overlayQueue.shift();
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            this.overlayChainTimer = setTimeout(() => this.openOverlay(next), 900);
        }
    }

    handleOverlayClose() {
        this.closeOverlay();
    }

    /* ---------------- small derived values ---------------- */
    get settings() {
        return (this.data && this.data.settings) || {};
    }

    get currentTier() {
        return this.tiers[this.tierIdx];
    }

    get alertClass() {
        if (!this.activeAlert) return 'alert-card';
        const vis = this.alertVisible ? ' visible' : '';
        if (this.activeAlert.type === 'positive') return `alert-card positive${vis}`;
        return `alert-card ${this.activeAlert.severity}${vis}`;
    }

    get alertBadge() {
        if (!this.activeAlert) return '';
        if (this.activeAlert.type === 'positive') {
            return this.activeAlert.allClear ? 'ALL CLEAR' : this.activeAlert.label;
        }
        return this.activeAlert.severity === 'critical' ? 'CRITICAL ALERT' : 'IMPORTANT ALERT';
    }

    get alertSub() {
        if (!this.activeAlert) return '';
        if (this.activeAlert.type === 'positive') return this.activeAlert.value || '';
        return this.activeAlert.zeros > 0
            ? `${this.activeAlert.zeros} metrics at zero today`
            : `${this.activeAlert.reasons.length} metrics below average`;
    }

    get alertChips() {
        if (!this.activeAlert || this.activeAlert.type === 'positive') return [];
        return this.activeAlert.reasons.slice(0, 4).map((r) => ({
            key: r.metric,
            text: `${r.metric}: ${r.value}`
        }));
    }

    get lastUpdatedText() {
        if (!this.data) return '--:--:--';
        return this.istTime(new Date(this.data.lastUpdated));
    }

    get hasWarnings() {
        return this.data && this.data.warnings && this.data.warnings.length > 0;
    }

    /**
     * FIX (audit finding #20): the template previously used the warning TEXT
     * itself as the for:each key. Two coincidentally-identical warning strings
     * (plausible -- several warnings share a similar generated shape) would
     * produce a duplicate-key console warning. Keyed on stable array index instead.
     */
    get warningItems() {
        if (!this.data || !this.data.warnings) return [];
        return this.data.warnings.map((text, idx) => ({ key: `warn-${idx}`, text }));
    }

    /* ---------------- helpers ---------------- */
    updateClock() {
        this.clockText = this.istTime(new Date());
    }

    istTime(d) {
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(d);
    }

    formatTotal(m) {
        const v = this.data.totals[m.key] || 0;
        return m.unit === 'min' ? Math.round(v).toLocaleString() : Number(v).toLocaleString();
    }

    boardTotal(m, rows) {
        if (m.isRate) {
            const pool = qualifiedPool(rows, m, this.currentTier);
            const num = pool.reduce((s, r) => s + (r.metrics[m.numeratorKey] || 0), 0);
            const den = pool.reduce((s, r) => s + (r.metrics[m.denominatorKey] || 0), 0);
            return den > 0 ? `${Math.round((num / den) * 100)}%` : '0%';
        }
        const total = rows.reduce((s, r) => s + (r.metrics[m.key] || 0), 0);
        return m.unit === 'min' ? `${Math.round(total)}` : `${total}`;
    }


    /* ====================================================================
     * MANAGER / HEAD OVERLAY (inlined -- was a separate salesArenaOverlay
     * component; consolidated into this single bundle per the requested
     * structure). Reads from this.data (already loaded) and this.overlayLevel
     * (already tracked for scheduling) instead of separate @api properties.
     * ================================================================== */

    get overlayTitle() {
        return this.overlayLevel === 'head' ? 'HEAD PERFORMANCE' : 'MANAGER PERFORMANCE';
    }

    get overlaySubtitle() {
        return this.overlayLevel === 'head'
            ? 'Ranked by conversion \u00B7 expanded by manager \u00B7 today \u00B7 IST'
            : 'Ranked by conversion \u00B7 per-caller averages \u00B7 today \u00B7 IST';
    }

    get overlaySubLabel() {
        return this.overlayLevel === 'head' ? 'Mgrs' : 'TLs';
    }

    get overlayRateMetric() {
        return this.data && this.data.metricDefs ? this.data.metricDefs.find((m) => m.isRate) : null;
    }

    /**
     * Audit finding #3: the overlay must never crash the whole component just
     * because metricDefs (hardcoded, or CMDT-sourced) ends up with no rate
     * metric. Surfaced as a clear, closable message instead of an uncaught
     * exception from a template getter.
     */
    get overlayHasConfigError() {
        return this.overlayVisible && !this.overlayRateMetric;
    }

    get overlayConfigErrorMessage() {
        return 'This view needs a rate metric (e.g. Cond vs Sched) to rank by, '
            + 'but none is configured. Check GSquareSalesArenaMetric__mdt or '
            + 'GSquareSalesArenaWrapper.cls for a metric with Is_Rate__c = true.';
    }

    /** Column headers generated from config -- never hardcoded. */
    get overlayColumns() {
        if (!this.data) return [];
        return orderedMetrics(this.data.metricDefs).map((m) => ({
            key: m.key,
            label: m.isRate ? m.label : `Avg ${m.label}`
        }));
    }

    get overlayRows() {
        if (!this.data || !this.overlayVisible) return [];
        const rm = this.overlayRateMetric;
        if (!rm) return [];

        const people = this.data.people;
        const defs = this.data.metricDefs;
        const level = this.overlayLevel;

        const groups = averages(people, defs, level).sort(
            (a, b) => (b.metrics[rm.key] || 0) - (a.metrics[rm.key] || 0)
        );

        const out = [];
        groups.forEach((g, i) => {
            out.push(this.overlayToRow(g, i + 1, false));
            if (level === 'head') {
                const members = people.filter((p) => p.headName === g.name);
                averages(members, defs, 'manager')
                    .sort((a, b) => (b.metrics[rm.key] || 0) - (a.metrics[rm.key] || 0))
                    .forEach((s) => out.push(this.overlayToRow(s, null, true)));
            }
        });

        const totalN = groups.reduce((s, g) => s + g.count, 0);
        if (totalN > 0) {
            const floor = { name: 'Floor Average', count: totalN, subCount: '', metrics: {}, raw: {} };
            defs.forEach((m) => {
                floor.raw[m.key] = groups.reduce((s, g) => s + (g.raw[m.key] || 0), 0);
                floor.metrics[m.key] = floor.raw[m.key] / totalN;
            });
            const num = groups.reduce((s, g) => s + (g.raw[rm.numeratorKey] || 0), 0);
            const den = groups.reduce((s, g) => s + (g.raw[rm.denominatorKey] || 0), 0);
            floor.metrics[rm.key] = den > 0 ? (num / den) * 100 : 0;
            const row = this.overlayToRow(floor, null, false);
            row.rowClass = 'floor-row';
            out.push(row);
        }
        return out;
    }

    overlayToRow(g, rankNum, isSub) {
        const settings = this.settings;
        const good = settings.rateGoodThreshold || 25;
        const bad = settings.rateBadThreshold || 12;
        const defs = this.data.metricDefs;
        return {
            key: `${g.realId || g.name}-${isSub ? 'sub' : 'main'}`,
            rank: rankNum || '',
            name: isSub ? `\u21B3 ${g.name}` : g.name,
            subCount: g.subCount === undefined ? '' : g.subCount,
            count: g.count,
            rowClass: isSub ? 'sub-row' : '',
            cells: orderedMetrics(defs).map((m) => {
                const raw = g.raw[m.key] || 0;
                const useRaw = !m.isRate && raw < g.count * 0.1;
                const v = m.isRate ? g.metrics[m.key] : useRaw ? raw : g.metrics[m.key];
                let cls = 'num';
                if (m.isRate) cls += v >= good ? ' best' : v < bad ? ' worst' : '';
                return {
                    key: m.key,
                    cssClass: cls,
                    text: m.isRate
                        ? `${Number(v).toFixed(1)}%`
                        : useRaw
                        ? `${v}`
                        : Number(v).toFixed(m.unit === 'min' ? 0 : 2)
                };
            })
        };
    }

    get overlayNote() {
        if (!this.data || !this.overlayVisible) return '';
        const field = `${this.overlayLevel}Name`;
        const excluded = this.data.people.filter((p) => !p[field] || p[field] === 'Unassigned').length;
        const bits = [];
        if (excluded) bits.push(`${excluded} callers excluded (no ${this.overlayLevel} mapped)`);
        bits.push('Per-caller averages include zero-activity callers');
        return bits.join('  \u00B7  ');
    }

}