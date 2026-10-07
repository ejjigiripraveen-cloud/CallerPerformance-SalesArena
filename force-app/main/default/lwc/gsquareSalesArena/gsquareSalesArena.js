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
============================================================================= */

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

// Purely presentational icon lookup, keyed by metric key -- matches the
// originally approved HTML design. Never affects data or business logic;
// safe to edit freely for a visual-only change.
const METRIC_ICONS = {
    allocation: '\ud83d\udccb',
    svScheduled: '\ud83d\uddd3\ufe0f',
    svConducted: '\ud83c\udfe0',
    booking: '\ud83c\udfc6',
    talktime: '\ud83d\udcde'
};

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
const EXCLUDED_FILTER_NAMES = ['Uma Maheswari'];

function isExcludedFromFilters(name) {
    return EXCLUDED_FILTER_NAMES.some((n) => name && name.startsWith(n));
}

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
 *
 * @param tier one of TIER.*
 * @param teamTlId required when tier === TIER.TEAM
 * @param opts.includeUnassigned
 */
function aggregate(people, metricDefs, tier, teamTlId, opts = {}) {
    const includeUnassigned = opts.includeUnassigned === true;

    if (tier === TIER.INDIVIDUAL) {
        return people.map((p) =>
            applyRates(
                {
                    name: p.name,
                    id: p.userId,
                    tlName: p.tlName,
                    metrics: { ...p.metrics }
                },
                metricDefs
            )
        );
    }

    if (tier === TIER.TEAM) {
        return people
            .filter((p) => p.tlId === teamTlId)
            .map((p) =>
                applyRates(
                    {
                        name: p.name,
                        id: p.userId,
                        metrics: { ...p.metrics }
                    },
                    metricDefs
                )
            );
    }

    const field = TIER_GROUP_FIELD[tier];
    const idField = TIER_ID_FIELD[tier];
    const groups = {};

    people.forEach((p) => {
        const name = p[field] || UNASSIGNED;

        if (name === UNASSIGNED && !includeUnassigned) {
            return;
        }

        const groupKey =
            name === UNASSIGNED
                ? UNASSIGNED
                : p[idField] || name;

        if (!groups[groupKey]) {
            groups[groupKey] = {
                name,
                id: groupKey,
                realId: groupKey,
                count: 0,
                subs: new Set(),
                metrics: {}
            };
        }

        const g = groupKey;

        groups[g].count += 1;

        if (
            tier === TIER.HEAD &&
            p.managerName !== UNASSIGNED
        ) {
            groups[g].subs.add(p.managerName);
        }

        if (
            tier === TIER.MANAGER &&
            p.tlName !== UNASSIGNED
        ) {
            groups[g].subs.add(p.tlName);
        }

        metricDefs
            .filter((m) => !m.isRate)
            .forEach((m) => {
                groups[g].metrics[m.key] =
                    (groups[g].metrics[m.key] || 0) +
                    (p.metrics[m.key] || 0);
            });
    });

    return Object.values(groups).map((g) => {
        g.subCount = g.subs.size;
        delete g.subs;

        return applyRates(g, metricDefs);
    });
}

/**
 * True floor-wide totals.
 */
function floorTotals(people, metricDefs) {
    const totals = {};

    metricDefs
        .filter((m) => !m.isRate)
        .forEach((m) => {
            totals[m.key] = people.reduce(
                (s, p) => s + (p.metrics[m.key] || 0),
                0
            );
        });

    metricDefs
        .filter((m) => m.isRate)
        .forEach((m) => {
            const num = totals[m.numeratorKey] || 0;
            const den = totals[m.denominatorKey] || 0;

            totals[m.key] =
                den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
        });

    return totals;
}

/** Per-caller averages -- used by Manager and Head overlays. */
function averages(people, metricDefs, tier) {
    return aggregate(people, metricDefs, tier).map((g) => {
        const out = {
            name: g.name,
            realId: g.realId,
            count: g.count,
            subCount: g.subCount,
            metrics: {}
        };

        metricDefs.forEach((m) => {
            out.metrics[m.key] = m.isRate
                ? g.metrics[m.key]
                : (g.metrics[m.key] || 0);
        });

        out.raw = { ...g.metrics };

        return out;
    });
}

/* -------------------------------------------------------------------------
 * Ranking
 * ---------------------------------------------------------------------- */

function qualifiedPool(rows, metric, tier) {
    if (!metric.isRate) {
        return rows;
    }

    const min =
        (metric.minVolumeByTier &&
            metric.minVolumeByTier[tier]) ||
        5;

    return rows.filter(
        (r) =>
            (r.metrics[metric.denominatorKey] || 0) >=
            min
    );
}

function minVolumeFor(metric, tier) {
    if (!metric.isRate) {
        return null;
    }

    return (
        (metric.minVolumeByTier &&
            metric.minVolumeByTier[tier]) ||
        5
    );
}

function rank(
    rows,
    metric,
    { tier, limit = 10, direction = 'top' } = {}
) {
    const pool = qualifiedPool(rows, metric, tier).filter(
        (r) => (r.metrics[metric.key] || 0) > 0
    );

    const sorted = [...pool].sort((a, b) =>
        direction === 'bottom'
            ? a.metrics[metric.key] -
              b.metrics[metric.key]
            : b.metrics[metric.key] -
              a.metrics[metric.key]
    );

    return sorted
        .slice(0, limit)
        .map((r, idx, arr) => {
            const trueRank =
                direction === 'bottom'
                    ? pool.length - idx
                    : idx + 1;

            return decorate(
                r,
                idx,
                arr,
                metric,
                trueRank
            );
        });
}

function decorate(
    row,
    idx,
    arr,
    metric,
    trueRank
) {
    const value = row.metrics[metric.key] || 0;
    const top = arr[0]
        ? arr[0].metrics[metric.key]
        : 1;

    const prev =
        idx > 0
            ? arr[idx - 1].metrics[metric.key]
            : null;

    const gapRaw =
        prev === null ? null : prev - value;

    return {
        key: `${metric.key}-${row.realId || row.id}`,
        name: row.name,
        tlName: row.tlName,
        rank: trueRank,
        rankClass:
            idx === 0
                ? 'row r1'
                : idx === 1
                ? 'row r2'
                : idx === 2
                ? 'row r3'
                : 'row',
        value: formatValue(value, metric),
        barStyle: `width:${Math.max(
            6,
            Math.min(
                100,
                top > 0
                    ? (value / top) * 100
                    : 0
            )
        )}%`,
        isLead: idx === 0,
        gap:
            gapRaw === null
                ? 'LEAD'
                : gapRaw > 0
                ? `-${roundGap(
                      gapRaw,
                      metric
                  )}`
                : '=',
        gapClass:
            gapRaw !== null &&
            gapRaw <= closeThreshold(metric)
                ? 'rgap close'
                : 'rgap',
        subLabel: metric.isRate
            ? `${fmtNum(
                  row.metrics[
                      metric.numeratorKey
                  ]
              )}/${fmtNum(
                  row.metrics[
                      metric.denominatorKey
                  ]
              )}`
            : null
    };
}

function closeThreshold(metric) {
    if (metric.isRate) return 2;
    if (metric.unit === 'min') return 5;

    return 1;
}

function roundGap(g, metric) {
    return metric.isRate || metric.unit === 'min'
        ? Math.round(g)
        : g;
}

function fmtNum(v) {
    return Math.round(v || 0);
}

function formatValue(v, metric) {
    if (metric.isRate) {
        return `${Math.round(v)}`;
    }

    if (metric.unit === 'min') {
        return `${Math.round(v)}`;
    }

    return `${v}`;
}

/* -------------------------------------------------------------------------
 * Insights
 * ---------------------------------------------------------------------- */

function insights(people, metricDefs, keys) {
    const rows = aggregate(
        people,
        metricDefs,
        TIER.INDIVIDUAL
    );

    return keys
        .map((k) => findMetric(metricDefs, k))
        .filter(Boolean)
        .map((m) => {
            const top = rank(rows, m, {
                tier: TIER.INDIVIDUAL,
                limit: 1
            })[0];

            return {
                key: m.key,
                label: `Most ${m.label}`,
                icon: m.icon,
                name: top ? top.name : '\u2014',
                metric: top
                    ? `${top.value}${m.unit}`
                    : '\u2014'
            };
        });
}

/* -------------------------------------------------------------------------
 * Dominant Team
 * ---------------------------------------------------------------------- */

function dominantTeam(rows, metricDefs) {
    if (!rows.length) {
        return null;
    }

    const boardable = boardMetrics(metricDefs);
    const wins = {};

    boardable.forEach((m) => {
        const top = rank(rows, m, {
            tier: TIER.TL,
            limit: 1
        })[0];

        if (top) {
            wins[top.name] =
                (wins[top.name] || 0) + 1;
        }
    });

    const names = Object.keys(wins);

    if (!names.length) {
        return null;
    }

    names.sort(
        (a, b) => wins[b] - wins[a]
    );

    return {
        name: names[0],
        metricsWon: wins[names[0]],
        totalMetrics: boardable.length
    };
}

/* -------------------------------------------------------------------------
 * Watchlist / alerts
 * ---------------------------------------------------------------------- */

function watchlist(
    people,
    metricDefs,
    settings
) {
    const mapped = people.filter(
        (p) => p.tlName !== UNASSIGNED
    );

    if (!mapped.length) {
        return [];
    }

    const scored = metricDefs.filter(
        (m) => !m.isRate
    );

    const avg = {};

    scored.forEach((m) => {
        avg[m.key] =
            mapped.reduce(
                (s, p) =>
                    s + (p.metrics[m.key] || 0),
                0
            ) / mapped.length;
    });

    const out = [];

    mapped.forEach((p) => {
        const reasons = scored
            .filter(
                (m) =>
                    (p.metrics[m.key] || 0) <
                    avg[m.key]
            )
            .map((m) => ({
                metric: m.label,
                value: Math.round(
                    p.metrics[m.key] || 0
                ),
                isZero:
                    (p.metrics[m.key] || 0) === 0
            }));

        if (
            reasons.length >=
            settings.watchlistMinWeak
        ) {
            const zeros = reasons.filter(
                (r) => r.isZero
            ).length;

            out.push({
                name: p.name,
                tlName: p.tlName,
                managerName: p.managerName,
                headName: p.headName,
                metrics: { ...p.metrics },
                reasons,
                zeros,
                severity:
                    zeros >=
                    settings.alertCriticalZeroCount
                        ? 'critical'
                        : 'important'
            });
        }
    });

    out.sort(
        (a, b) =>
            b.zeros - a.zeros ||
            b.reasons.length -
                a.reasons.length
    );

    return out.slice(
        0,
        settings.watchlistMaxEntries
    );
}

function buildAlertQueue(
    people,
    metricDefs,
    settings
) {
    const negatives = watchlist(
        people,
        metricDefs,
        settings
    ).map((w) => ({
        type: 'negative',
        severity: w.severity,
        name: w.name,
        tlName: w.tlName,
        zeros: w.zeros,
        reasons: w.reasons
    }));

    const rows = aggregate(
        people,
        metricDefs,
        TIER.INDIVIDUAL
    );

    const positives = orderedMetrics(metricDefs)
        .map((m) => {
            const top = rank(rows, m, {
                tier: TIER.INDIVIDUAL,
                limit: 1
            })[0];

            return top
                ? {
                      type: 'positive',
                      key: m.key,
                      name: top.name,
                      tlName: top.tlName,
                      label: `Top ${m.label}`,
                      value: `${top.value}${m.unit}`,
                      icon: m.icon
                  }
                : null;
        })
        .filter(Boolean);

    const merged = [];
    let p = 0;

    negatives.forEach((n, i) => {
        merged.push(n);

        if (
            (i + 1) % 3 === 0 &&
            positives.length
        ) {
            merged.push(
                positives[
                    p++ % positives.length
                ]
            );
        }
    });

    if (!merged.length) {
        merged.push(...positives);
    }

    if (!merged.length) {
        merged.push({
            type: 'positive',
            allClear: true,
            name: 'All Clear'
        });
    }

    return merged;
}

export default class GsquareSalesArena extends LightningElement {
    @track data;
    @track error;
    @track loading = true;
    @track isStale = false;
    @track staleSinceText = '';

    // cached view models
    @track boards = [];
    @track funnelCards = [];
    @track funnelLinks = [];
    @track insightCards = [];

    wiredResult;

    // rotation state
    tiers = [
        TIER.INDIVIDUAL,
        TIER.TL
    ];

    tierIdx = 0;
    tierElapsed = 0;
    tickCount = 0;
    boardMode = 'top';
    teamCursor = 0;

    @track currentTeamTl = null;
    currentTeamId = null;
    @track tierLabel = 'FLOOR LEADERBOARD';
    @track isTeamTier = false;
    @track teamMeta = null;

    // FTD/MTD toggle. 'TODAY' or 'THIS_MONTH' -- passed to Apex as a
    // reactive wire parameter, so changing it automatically re-fetches.
    // Only affects KPIs/leaderboards (rangeMetrics); the Critical Alert
    // popup and Watchlist always stay on today's numbers (metrics),
    // confirmed requirement, unaffected by this toggle.
    @track dateRangeMode = 'TODAY';

    // Pause: freezes ONLY the tier/board rotation (tick()'s tier-advance
    // logic). Data refresh (refreshApex every 3 min) is NOT affected --
    // confirmed scope.
    @track isPaused = false;

    // Zone/Head/Manager/TL filters. Zone is deliberately independent -- it
    // does NOT participate in the Head->Manager->TL cascade (confirmed).
    // Empty string means "All" for that dimension.
    @track selectedZone = '';
    @track selectedHead = '';
    @track selectedManager = '';
    @track selectedTl = '';

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

    /* ==================================================================
     * FULL SCREEN
     * ================================================================== */

    openFullScreen() {
    console.log('Called');

    const stage = this.template.querySelector('.stage');

    if (!stage) {
        console.error('Stage element not found');
        return;
    }

    const expanded = stage.classList.toggle('arena-expanded');

    console.log('Expanded:', expanded);
}

    /* ================================================================== */

    @wire(getDashboard, { dateRangeMode: '$dateRangeMode' })
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
                this.isStale = true;
                this.staleSinceText =
                    this.lastUpdatedText;
            } else {
                this.error = error.body
                    ? error.body.message
                    : error.message;
            }

            this.loading = false;
        }
    }

    connectedCallback() {
        this.updateClock();

        this.timers.push(
            setInterval(
                () => this.updateClock(),
                1000
            )
        );
    }

    disconnectedCallback() {
        this.timers.forEach((t) =>
            clearInterval(t)
        );

        this.timers = [];

        if (this.overlayTimer) {
            clearTimeout(this.overlayTimer);
        }

        if (this.overlayChainTimer) {
            clearTimeout(
                this.overlayChainTimer
            );
        }

        if (this.alertAnimTimer) {
            clearTimeout(
                this.alertAnimTimer
            );
        }

        if (document.fullscreenElement) {
            document.exitFullscreen().catch(
                () => {}
            );
        }
    }

    /* ---------------- data-driven rebuild ---------------- */

    onDataChanged() {
        this.refreshAlertQueue();
        this.validateTeamRoster();
        this.buildStatic();
        this.buildBoards();
        this.startTimers();
    }

    /**
     * The single filtering choke point: every metric on screen (KPIs,
     * funnel, insights, every leaderboard, Team Spotlight, and the alert
     * popup) reads from THIS, not from this.data.people directly. Zone is
     * deliberately independent of the Head->Manager->TL cascade -- it's
     * simply ANDed in alongside the other three.
     */
    get scopedPeople() {
        if (!this.data) return [];
        return this.data.people.filter((p) => {
            if (this.selectedZone && p.zone !== this.selectedZone) return false;
            if (this.selectedHead && p.headName !== this.selectedHead) return false;
            if (this.selectedManager && p.managerName !== this.selectedManager) return false;
            if (this.selectedTl && p.tlName !== this.selectedTl) return false;
            return true;
        });
    }

    /**
     * FTD/MTD toggle: the KPI strip and every leaderboard must follow
     * whichever range is selected (rangeMetrics), while the Critical Alert
     * popup and Watchlist must ALWAYS stay on today's numbers (metrics) --
     * confirmed requirement. Rather than teach every shared function
     * (aggregate, rank, floorTotals, insights, averages) about two separate
     * metric maps, this builds one derived view where `.metrics` transparently
     * points to rangeMetrics -- every existing function keeps reading
     * `.metrics` completely unchanged, it just sees different numbers under
     * that name for board-building purposes specifically.
     */
    get scopedPeopleForBoards() {
        return this.scopedPeople.map((p) => ({ ...p, metrics: p.rangeMetrics || p.metrics }));
    }

    /**
     * The single source of truth for "who counts as an eligible caller" for
     * Critical Alert / Watchlist purposes -- profile filter AND minimum
     * calls-made threshold. Used by refreshAlertQueue() (the live popup),
     * handleCriticalExportClick() (the export), and hasCriticalEntries (the
     * export button's visibility) -- all three MUST use this exact same
     * population, or the export can silently drift from what the popup
     * actually shows (confirmed bug: TLs/Managers/Heads with zero caller
     * activity were leaking into the export and corrupting the floor-average
     * calculation used to decide who's "below average").
     */
    get eligibleCallers() {
        const s = this.settings;
        const callerProfile = s.alertPopupProfile || 'Presales outbound';
        const MIN_CALLS_MADE_FOR_ALERT = 10;
        return this.scopedPeople.filter(
            (p) =>
                p.profileName === callerProfile &&
                (p.metrics.callsMade || 0) >= MIN_CALLS_MADE_FOR_ALERT &&
                p.availability !== false &&
                p.tenureEligible !== false
        );
    }

    refreshAlertQueue() {
        const s = this.settings;
        this.alertQueue = buildAlertQueue(this.eligibleCallers, this.data.metricDefs, s);
    }

    /**
     * Team Spotlight's roster must be recomputed from scopedPeople, not the
     * server's floor-wide this.data.teamRoster -- otherwise a filter that
     * narrows to one Manager's org would still let Team Spotlight cycle
     * through every team on the whole floor. Grouped by real tlId, never by
     * name (two different TLs can share an identical Name).
     */
    computeScopedTeamRoster() {
        const counts = new Map();
        this.scopedPeople.forEach((p) => {
            if (!p.tlId || p.tlName === UNASSIGNED) return;
            const entry = counts.get(p.tlId) || { tlId: p.tlId, tlName: p.tlName, teamSize: 0 };
            entry.teamSize += 1;
            counts.set(p.tlId, entry);
        });
        return [...counts.values()].sort(
            (a, b) => b.teamSize - a.teamSize || a.tlName.localeCompare(b.tlName)
        );
    }

    /**
     * If a TL is deactivated/reassigned -- or a filter changes what's in
     * scope -- between refreshes, a stale reference would keep matching
     * zero people. Re-validated on every data refresh AND every filter
     * change, not just first load.
     */
    validateTeamRoster() {
        const roster = this.computeScopedTeamRoster();
        const stillValid = roster.find((r) => r.tlId === this.currentTeamId);
        if (!roster.length) {
            this.currentTeamId = null;
            this.currentTeamTl = null;
        } else if (!stillValid) {
            const entry = roster[this.teamCursor % roster.length] || roster[0];
            this.currentTeamId = entry.tlId;
            this.currentTeamTl = entry.tlName;
        }
    }

    buildStatic() {
        const defs =
            this.data.metricDefs;

        const people = this.scopedPeopleForBoards;

        // Recomputed client-side from whatever's currently in scope, rather
        // than using the server's floor-wide this.data.totals directly --
        // otherwise the KPI/funnel strip would keep showing unfiltered
        // numbers even while every leaderboard below it is scoped to a
        // filter. With no filter active, scopedPeople === all people, so
        // this produces the identical result to the server total anyway.
        const totals = floorTotals(people, defs);

        const funnelDefs =
            funnelMetrics(defs);

        const cardFor = (m) => ({
            type: 'card',
            isCard: true,
            key: m.key,
            label: m.label,
            value: this.formatTotal(m, totals),
            icon:
                METRIC_ICONS[m.key] || '',
            cssClass:
                `kpi-card accent-${m.key}`
        });

        const rateMetric =
            defs.find((m) => m.isRate);

        const showupPct = rateMetric
            ? totals[rateMetric.key] || 0
            : 0;

        const svConducted =
            totals.svConducted || 0;

        const bookingPct =
            svConducted > 0
                ? Math.round(
                      ((totals.booking ||
                          0) /
                          svConducted) *
                          100
                  )
                : 0;

        const bad =
            this.settings
                .rateBadThreshold || 12;

        const linkFor = (
            pct,
            label
        ) => ({
            type: 'link',
            isCard: false,
            key: `link-${label}`,
            neutral: false,
            arrow: '\u2192',
            pct: `${pct}%`,
            label,
            cssClass:
                pct < bad
                    ? 'funnel-link weak'
                    : 'funnel-link'
        });

        const neutralLink = {
            type: 'link',
            isCard: false,
            key: 'link-leadflow',
            neutral: true,
            arrow: '\u2192',
            pct: '',
            label: 'lead flow',
            cssClass:
                'funnel-link neutral'
        };

        this.funnelStrip = [];

        funnelDefs.forEach((m, i) => {
            this.funnelStrip.push(
                cardFor(m)
            );

            if (i === 0) {
                this.funnelStrip.push(
                    neutralLink
                );
            } else if (i === 1) {
                this.funnelStrip.push(
                    linkFor(
                        showupPct,
                        'show-up rate'
                    )
                );
            } else if (i === 2) {
                this.funnelStrip.push(
                    linkFor(
                        bookingPct,
                        'booking rate'
                    )
                );
            }
        });

        const keys =
            orderedMetrics(defs)
                .filter(
                    (m) => m.showInFunnel
                )
                .map((m) => m.key);

        this.insightCards =
            insights(
                people,
                defs,
                keys
            ).map((c) => ({
                ...c,
                icon:
                    METRIC_ICONS[c.key] ||
                    '',
                cssClass:
                    `insight-card accent-${c.key}`
            }));
    }

    buildBoards() {
        if (!this.data) {
            return;
        }

        const tier =
            this.currentTier;

        const rows = aggregate(
            this.scopedPeopleForBoards,
            this.data.metricDefs,
            tier,
            this.currentTeamId
        );

        const limit =
            tier === TIER.TEAM
                ? 99
                : this.settings
                      .boardRowLimit ||
                  10;

        this.boards =
            boardMetrics(
                this.data.metricDefs
            ).map((m) => {
                const ranked = rank(
                    rows,
                    m,
                    {
                        tier,
                        limit,
                        direction:
                            this.boardMode
                    }
                );

                const minVol =
                    minVolumeFor(
                        m,
                        tier
                    );

                return {
                    key: m.key,
                    label: m.isRate
                        ? `${m.label} (Qualified)`
                        : m.label,
                    qualifier: minVol
                        ? `min ${minVol}`
                        : null,
                    total:
                        this.boardTotal(
                            m,
                            rows
                        ),
                    rows: ranked,
                    hasRows:
                        ranked.length > 0,
                    emptyText:
                        m.isRate
                            ? `Below ${minVol} scheduled`
                            : 'No activity yet',
                    cssClass:
                        `board metric-${m.key} mode-${this.boardMode}`
                };
            });

        this.tierLabel =
            tier === TIER.TEAM
                ? 'TEAM SPOTLIGHT'
                : tier === TIER.TL
                ? 'TEAM LEADER LEADERBOARD'
                : 'FLOOR LEADERBOARD';

        this.isTeamTier =
            tier === TIER.TEAM;

        this.teamMeta =
            this.isTeamTier
                ? this.computeTeamMeta()
                : null;
    }

    computeTeamMeta() {
        const size =
            this.scopedPeople.filter(
                (p) =>
                    p.tlId ===
                    this.currentTeamId
            ).length;

        const total =
            this.computeScopedTeamRoster()
                .length;

        const pos = total
            ? ((this.teamCursor -
                  1 +
                  total) %
                  total) +
              1
            : 0;

        return `${size} callers \u00B7 ${pos}/${total}`;
    }

    /* ---------------- timers ---------------- */

    startTimers() {
        if (this.timersStarted) {
            return;
        }

        this.timersStarted = true;

        const s = this.settings;

        this.timers.push(
            setInterval(
                () => this.tick(),
                100
            )
        );

        this.nextAlert();

        this.timers.push(
            setInterval(
                () => this.nextAlert(),
                (s.alertHoldSeconds || 7) *
                    1000
            )
        );

        this.timers.push(
            setInterval(
                () =>
                    this.openOverlay(
                        'manager'
                    ),
                (s.overlayManagerMinutes ||
                    20) *
                    60000
            )
        );

        this.timers.push(
            setInterval(
                () =>
                    this.openOverlay(
                        'head'
                    ),
                (s.overlayHeadMinutes ||
                    30) *
                    60000
            )
        );

        this.timers.push(
            setInterval(
                () =>
                    refreshApex(
                        this.wiredResult
                    ),
                (s.refreshSeconds ||
                    180) *
                    1000
            )
        );
    }

    tick() {
        // Pause freezes ONLY the tier/board rotation -- confirmed scope.
        // Data refresh (a separate interval) keeps running underneath.
        if (this.isPaused) return;

        const s = this.settings;

        const tierSeconds =
            s.tierSeconds || 10;

        this.tickCount += 1;

        this.tierElapsed =
            this.tickCount / 10;

        const bar =
            this.template.querySelector(
                '.tier-timer-fill'
            );

        if (bar) {
            bar.style.width = `${Math.min(
                100,
                (this.tierElapsed /
                    tierSeconds) *
                    100
            )}%`;
        }

        let dirty = false;

        if (
            this.currentTier !==
            TIER.TEAM
        ) {
            const target =
                this.tierElapsed <
                (s.modeFlipSeconds || 5)
                    ? 'top'
                    : 'bottom';

            if (
                target !==
                this.boardMode
            ) {
                this.boardMode =
                    target;

                dirty = true;
            }
        }

        if (
            this.tickCount >=
            tierSeconds * 10
        ) {
            this.tickCount = 0;
            this.tierElapsed = 0;

            this.tierIdx =
                (this.tierIdx + 1) %
                this.tiers.length;

            this.boardMode = 'top';

            if (
                this.currentTier ===
                TIER.TEAM
            ) {
                const roster =
                    this.computeScopedTeamRoster();

                if (roster.length) {
                    const entry =
                        roster[
                            this.teamCursor %
                                roster.length
                        ];

                    this.currentTeamId =
                        entry.tlId;

                    this.currentTeamTl =
                        entry.tlName;

                    this.teamCursor += 1;
                }
            }

            dirty = true;
        }

        if (dirty) {
            this.buildBoards();
        }
    }

    /* ---------------- alerts ---------------- */

    nextAlert() {
        if (!this.alertQueue.length) {
            return;
        }

        this.alertVisible = false;

        if (this.alertAnimTimer) {
            clearTimeout(
                this.alertAnimTimer
            );
        }

        this.alertAnimTimer =
            setTimeout(() => {
                this.activeAlert =
                    this.alertQueue[
                        this.alertIdx %
                            this.alertQueue
                                .length
                    ];

                this.alertIdx += 1;

                this.alertVisible =
                    true;
            }, 400);
    }

    /* ---------------- overlays ---------------- */

    openOverlay(level) {
        if (this.overlayVisible) {
            if (
                !this.overlayQueue.includes(
                    level
                )
            ) {
                this.overlayQueue.push(
                    level
                );
            }

            return;
        }

        this.overlayLevel = level;
        this.overlayVisible = true;

        if (this.overlayTimer) {
            clearTimeout(
                this.overlayTimer
            );
        }

        this.overlayTimer =
            setTimeout(
                () => this.closeOverlay(),
                (this.settings
                    .overlayHoldSeconds ||
                    25) *
                    1000
            );
    }

    closeOverlay() {
        this.overlayVisible = false;

        if (this.overlayTimer) {
            clearTimeout(
                this.overlayTimer
            );
        }

        if (
            this.overlayQueue.length
        ) {
            const next =
                this.overlayQueue.shift();

            this.overlayChainTimer =
                setTimeout(
                    () =>
                        this.openOverlay(
                            next
                        ),
                    900
                );
        }
    }

    handleOverlayClose() {
        this.closeOverlay();
    }

    /* ---------------- Zone/Head/Manager/TL filters ---------------- */

    /** Zone options never narrow based on the other filters -- confirmed independent. */
    /**
     * Zone options are now a FIXED list -- only Chennai and Coimbatore --
     * per explicit requirement, not derived dynamically from whatever
     * Zone__c values happen to exist in the data. If Zone__c on some User
     * records has a different value (a third zone, a typo, blank, etc.),
     * those people simply won't match either filter option -- they'll only
     * show up under "All Zones".
     *
     * ASSUMPTION FLAGGED, NOT CONFIRMED: the exact stored casing/spelling of
     * these two picklist values was not verified against real data the way
     * every other field in this project was. If Zone__c actually stores
     * something like 'CHENNAI' or 'Chennai ' (trailing space) instead of
     * 'Chennai', this filter will silently match zero people for that zone
     * -- confirm the exact values in Setup -> Object Manager -> User ->
     * Fields -> Zone__c (or from real data) and correct the two strings
     * below if they don't match exactly.
     */
    get zoneOptions() {
        const FIXED_ZONES = ['Chennai', 'Coimbatore'];
        const all = [{ value: '', label: 'All Zones' }, ...FIXED_ZONES.map((z) => ({ value: z, label: z }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedZone }));
    }

    /** Head is the top of the cascade -- always shows every head, unaffected by Manager/TL selection. */
    /*get headOptions() {
        if (!this.data) return [];
        const heads = [...new Set(
            this.data.people.map((p) => p.headName).filter((h) => h && h !== UNASSIGNED)
        )].sort();
        const all = [{ value: '', label: 'All Heads' }, ...heads.map((h) => ({ value: h, label: h }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedHead }));
    }

    /** Manager options narrow to the selected Head's managers, if one is picked. 
    get managerOptions() {
        if (!this.data) return [];
        const pool = this.selectedHead
            ? this.data.people.filter((p) => p.headName === this.selectedHead)
            : this.data.people;
        const managers = [...new Set(
            pool.map((p) => p.managerName).filter((m) => m && m !== UNASSIGNED)
        )].sort();
        const all = [{ value: '', label: 'All Managers' }, ...managers.map((m) => ({ value: m, label: m }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedManager }));
    }

    /** TL options narrow to the selected Head AND/OR Manager, whichever are picked. 
    get tlOptions() {
        if (!this.data) return [];
        let pool = this.data.people;
        if (this.selectedHead) pool = pool.filter((p) => p.headName === this.selectedHead);
        if (this.selectedManager) pool = pool.filter((p) => p.managerName === this.selectedManager);
        const tls = [...new Set(pool.map((p) => p.tlName).filter((t) => t && t !== UNASSIGNED))].sort();
        const all = [{ value: '', label: 'All TLs' }, ...tls.map((t) => ({ value: t, label: t }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedTl }));
    }*/
    get headOptions() {
        if (!this.data) return [];
        const heads = [...new Set(
            this.data.people
                .map((p) => p.headName)
                .filter((h) => h && h !== UNASSIGNED && !isExcludedFromFilters(h))
        )].sort();
        const all = [{ value: '', label: 'All Heads' }, ...heads.map((h) => ({ value: h, label: h }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedHead }));
    }

    /** Manager options narrow to the selected Head's managers, if one is picked. */
    get managerOptions() {
        if (!this.data) return [];
        const pool = this.selectedHead
            ? this.data.people.filter((p) => p.headName === this.selectedHead)
            : this.data.people;
        const managers = [...new Set(
            pool
                .map((p) => p.managerName)
                .filter((m) => m && m !== UNASSIGNED && !isExcludedFromFilters(m))
        )].sort();
        const all = [{ value: '', label: 'All Managers' }, ...managers.map((m) => ({ value: m, label: m }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedManager }));
    }

    /** TL options narrow to the selected Head AND/OR Manager, whichever are picked. */
    get tlOptions() {
        if (!this.data) return [];
        let pool = this.data.people;
        if (this.selectedHead) pool = pool.filter((p) => p.headName === this.selectedHead);
        if (this.selectedManager) pool = pool.filter((p) => p.managerName === this.selectedManager);
        const tls = [...new Set(
            pool
                .map((p) => p.tlName)
                .filter((t) => t && t !== UNASSIGNED && !isExcludedFromFilters(t))
        )].sort();
        const all = [{ value: '', label: 'All TLs' }, ...tls.map((t) => ({ value: t, label: t }))];
        return all.map((o) => ({ ...o, selected: o.value === this.selectedTl }));
    }

    get hasActiveFilter() {
        return !!(this.selectedZone || this.selectedHead || this.selectedManager || this.selectedTl);
    }

    handleZoneChange(event) {
        this.selectedZone = event.target.value;
        this.rebuildFilteredView();
    }

    handleHeadChange(event) {
        this.selectedHead = event.target.value;
        // Cascading reset: a Manager/TL chosen under the old Head selection
        // may no longer even exist in the new Head's org, so clear both
        // rather than silently keep a now-meaningless selection active.
        this.selectedManager = '';
        this.selectedTl = '';
        this.rebuildFilteredView();
    }

    handleManagerChange(event) {
        this.selectedManager = event.target.value;
        this.selectedTl = '';
        this.rebuildFilteredView();
    }

    handleTlChange(event) {
        this.selectedTl = event.target.value;
        this.rebuildFilteredView();
    }

    handleResetFilters() {
        this.selectedZone = '';
        this.selectedHead = '';
        this.selectedManager = '';
        this.selectedTl = '';
        this.rebuildFilteredView();
    }

    /** Re-derives everything that depends on scopedPeople after a filter change. */
    rebuildFilteredView() {
        if (!this.data) return;
        this.refreshAlertQueue();
        this.validateTeamRoster();
        this.buildStatic();
        this.buildBoards();
    }

    /* ---------------- pause ---------------- */

    handlePauseToggle() {
        this.isPaused = !this.isPaused;
    }

    /**
     * Manual Top/Bottom Performer toggle. Normally boardMode flips
     * automatically inside tick() every modeFlipSeconds -- but tick() exits
     * immediately when isPaused is true, so boardMode would otherwise stay
     * frozen at whichever it happened to be on when Pause was pressed, with
     * no way to see the other view. This flips it manually and rebuilds the
     * boards immediately, independent of the (paused) rotation timer.
     */
    handleModeToggle() {
        this.boardMode = this.boardMode === 'top' ? 'bottom' : 'top';
        this.buildBoards();
    }

    get isBottomMode() {
        return this.boardMode === 'bottom';
    }

    /* ---------------- FTD / MTD ---------------- */

    /**
     * Switching dateRangeMode automatically re-fires the reactive wire
     * (@wire(getDashboard, { dateRangeMode: '$dateRangeMode' })) and fetches
     * fresh data for the newly selected range -- no manual refreshApex()
     * call needed. Only KPIs/leaderboards (rangeMetrics) follow this; the
     * Critical Alert popup and Watchlist always stay on today's numbers,
     * confirmed requirement.
     */
    handleDateRangeToggle() {
        this.dateRangeMode = this.isMonthMode ? 'TODAY' : 'THIS_MONTH';
    }

    get isMonthMode() {
        return this.dateRangeMode === 'THIS_MONTH';
    }

    get dateRangeLabel() {
        return this.isMonthMode ? 'MTD' : 'FTD';
    }

    /* ---------------- export ---------------- */

    /**
     * Builds an "Excel XML Spreadsheet" (SpreadsheetML) string, entirely
     * client-side, from data already loaded in this.data.people -- no new
     * Apex call, no new query, no third-party library or static resource
     * needed. Excel opens this natively as a real multi-sheet workbook.
     * One row per caller per sheet: User Name, TL Name, Manager Name,
     * Head Name, and that sheet's metric value. Exports the FULL unfiltered
     * dataset regardless of any active Zone/Head/Manager/TL filter, on the
     * assumption an export is meant to be a complete offline record.
     */
    /**
     * Builds an "Excel XML Spreadsheet" (SpreadsheetML) string, entirely
     * client-side, from data already loaded in this.data.people -- no new
     * Apex call, no new query, no third-party library or static resource
     * needed. Excel opens this natively as a real workbook.
     *
     * SINGLE SHEET, one row per caller, columns in this exact order (per
     * request): User Name, TL Name, Manager Name, Head Name, Allocation,
     * SV Scheduled, SV Conducted, Booking, No of Calls, Talktime.
     *
     * Previously this built ONE WORKSHEET PER METRIC (four separate tabs);
     * changed on request to a single combined sheet so every caller's full
     * weekly picture reads left-to-right in one place instead of requiring
     * tab-switching and manual cross-referencing in Excel. Also adds Calls
     * Made and Talktime, which were not in the export before.
     *
     * Exports the FULL unfiltered dataset regardless of any active
     * Zone/Head/Manager/TL filter, on the assumption an export is meant to
     * be a complete offline record -- unchanged from the prior behavior.
     */
    buildExportWorkbookXml(people, columns) {
        const escapeXml = (s) =>
            String(s === null || s === undefined ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

        const stringCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;
        const numberCell = (v) => `<Cell><Data ss:Type="Number">${Number(v) || 0}</Data></Cell>`;

        const headerRow =
            '<Row>' + columns.map((c) => stringCell(c.label)).join('') + '</Row>';

        const dataRows = people
            .map((p) => {
                const cells = columns
                    .map((c) => {
                        if (c.type === 'metric') {
                            const val = (p.metrics && p.metrics[c.key]) || 0;
                            return numberCell(val);
                        }
                        // c.type === 'name' -- direct field on the person record
                        return stringCell(p[c.key]);
                    })
                    .join('');
                return '<Row>' + cells + '</Row>';
            })
            .join('');

        const sheetXml = `<Worksheet ss:Name="Sales Arena Export"><Table>${headerRow}${dataRows}</Table></Worksheet>`;

        return (
            '<?xml version="1.0"?>\n' +
            '<?mso-application progid="Excel.Sheet"?>\n' +
            '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
            'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
            'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
            'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
            sheetXml +
            '\n</Workbook>'
        );
    }

    handleExportClick() {
        if (!this.data || !this.data.people || !this.data.people.length) return;

        const columns = [
            { label: 'User Name',     type: 'name',   key: 'name' },
            { label: 'TL Name',       type: 'name',   key: 'tlName' },
            { label: 'Manager Name',  type: 'name',   key: 'managerName' },
            { label: 'Head Name',     type: 'name',   key: 'headName' },
            { label: 'Allocation',    type: 'metric', key: 'allocation' },
            { label: 'SV Scheduled',  type: 'metric', key: 'svScheduled' },
            { label: 'SV Conducted',  type: 'metric', key: 'svConducted' },
            { label: 'Booking',       type: 'metric', key: 'booking' },
            { label: 'No of Calls',   type: 'metric', key: 'callsMade' },
            { label: 'Talktime',      type: 'metric', key: 'talktime' }
        ];

        const xml = this.buildExportWorkbookXml(this.data.people, columns);

        // Blob + URL.createObjectURL is blocked under Lightning Web Security
        // ("Unsupported MIME type") -- confirmed by two real runtime failures,
        // the second of which silently produced a broken href that caused the
        // browser to save the current Lightning page instead of the export.
        // A data: URI avoids the Blob-URL registry entirely (a different,
        // older mechanism LWS does not intercept the same way) and is a
        // well-established workaround for exactly this LWC/LWS restriction.
        const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(xml);
        const a = document.createElement('a');
        a.href = dataUri;
        const stamp = (this.lastUpdatedText || 'export').replace(/[^0-9A-Za-z]/g, '_');
        a.download = `SalesArena_Export_${stamp}.xls`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /**
     * Builds a SINGLE-sheet workbook containing only the people CURRENTLY
     * flagged on the Watchlist (below average on 3+ metrics today) -- the
     * same population and same daily-only data driving the Critical Alert
     * popup, computed via the identical watchlist() function so this export
     * can never drift out of sync with what the popup is actually showing.
     * Columns: Name, TL, Manager, Head, then one column per non-rate metric
     * (today's performance) -- matching the confirmed requirement.
     */
    buildCriticalListXml(entries, metricDefs) {
        const escapeXml = (s) =>
            String(s === null || s === undefined ? '' : s)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');

        const stringCell = (v) => `<Cell><Data ss:Type="String">${escapeXml(v)}</Data></Cell>`;
        const numberCell = (v) => `<Cell><Data ss:Type="Number">${Number(v) || 0}</Data></Cell>`;

        const metricCols = metricDefs.filter((m) => !m.isRate);

        const headerRow =
            '<Row>' +
            ['Name', 'TL Name', 'Manager Name', 'Head Name', 'Severity']
                .map(stringCell).join('') +
            metricCols.map((m) => stringCell(m.label)).join('') +
            '</Row>';

        const dataRows = entries
            .map((e) => {
                const nameCells =
                    stringCell(e.name) +
                    stringCell(e.tlName) +
                    stringCell(e.managerName) +
                    stringCell(e.headName) +
                    stringCell(e.severity === 'critical' ? 'Critical' : 'Important');
                const metricCells = metricCols
                    .map((m) => numberCell((e.metrics && e.metrics[m.key]) || 0))
                    .join('');
                return '<Row>' + nameCells + metricCells + '</Row>';
            })
            .join('');

        return (
            '<?xml version="1.0"?>\n' +
            '<?mso-application progid="Excel.Sheet"?>\n' +
            '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
            'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
            'xmlns:x="urn:schemas-microsoft-com:office:excel" ' +
            'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
            `<Worksheet ss:Name="Critical List"><Table>${headerRow}${dataRows}</Table></Worksheet>\n` +
            '</Workbook>'
        );
    }

    handleCriticalExportClick() {
        if (!this.data) return;

        // Uses eligibleCallers (the SAME filtered population refreshAlertQueue()
        // uses) rather than the raw scopedPeople -- confirmed fix: passing
        // unfiltered scopedPeople here let TLs/Managers/Heads (who
        // structurally have zero caller activity) leak into both the export
        // AND the floor-average calculation, corrupting who counts as
        // "below average" compared to what the live popup actually shows.
        const entries = watchlist(this.eligibleCallers, this.data.metricDefs, this.settings);

        if (!entries.length) return;  // nobody currently flagged -- nothing to export

        const xml = this.buildCriticalListXml(entries, this.data.metricDefs);
        const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(xml);
        const a = document.createElement('a');
        a.href = dataUri;
        const stamp = (this.lastUpdatedText || 'export').replace(/[^0-9A-Za-z]/g, '_');
        a.download = `SalesArena_CriticalList_${stamp}.xls`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    get hasCriticalEntries() {
        if (!this.data) return false;
        return watchlist(this.eligibleCallers, this.data.metricDefs, this.settings).length > 0;
    }

    /* ---------------- small derived values ---------------- */

    get settings() {
        return (
            (this.data &&
                this.data.settings) ||
            {}
        );
    }

    get currentTier() {
        return this.tiers[
            this.tierIdx
        ];
    }

    get alertClass() {
        if (!this.activeAlert) {
            return 'alert-card';
        }

        const vis =
            this.alertVisible
                ? ' visible'
                : '';

        if (
            this.activeAlert.type ===
            'positive'
        ) {
            return `alert-card positive${vis}`;
        }

        return `alert-card ${this.activeAlert.severity}${vis}`;
    }

    get alertBadge() {
        if (!this.activeAlert) {
            return '';
        }

        if (
            this.activeAlert.type ===
            'positive'
        ) {
            return this.activeAlert
                .allClear
                ? 'ALL CLEAR'
                : this.activeAlert
                      .label;
        }

        return this.activeAlert
            .severity === 'critical'
            ? 'CRITICAL ALERT'
            : 'IMPORTANT ALERT';
    }

    get alertSub() {
        if (!this.activeAlert) {
            return '';
        }

        if (
            this.activeAlert.type ===
            'positive'
        ) {
            return (
                this.activeAlert.value ||
                ''
            );
        }

        return this.activeAlert
            .zeros > 0
            ? `${this.activeAlert.zeros} metrics at zero today`
            : `${this.activeAlert.reasons.length} metrics below average`;
    }

    get isPositiveAlert() {
        return (
            !!this.activeAlert &&
            this.activeAlert.type ===
                'positive'
        );
    }

    get isAllClear() {
        return (
            !!this.activeAlert &&
            !!this.activeAlert.allClear
        );
    }

    get alertIndexLabel() {
        const len =
            this.alertQueue.length;

        if (!len) {
            return '';
        }

        const currentPos =
            ((this.alertIdx -
                1 +
                len) %
                len) +
            1;

        return `${currentPos} / ${len}`;
    }

    get alertChips() {
        if (!this.activeAlert) {
            return [];
        }

        if (
            this.activeAlert.type ===
            'positive'
        ) {
            if (
                this.activeAlert
                    .allClear
            ) {
                return [];
            }

            return [
                {
                    key: 'top-today',
                    text: `${METRIC_ICONS[
                        this.activeAlert
                            .key
                    ] || ''} #1 Today`.trim()
                }
            ];
        }

        return this.activeAlert.reasons.map(
            (r) => ({
                key: r.metric,
                text: `${r.metric}: ${r.value}`
            })
        );
    }

    get lastUpdatedText() {
        if (!this.data) {
            return '--:--:--';
        }

        return this.istTime(
            new Date(
                this.data.lastUpdated
            )
        );
    }

    get hasWarnings() {
        return (
            this.data &&
            this.data.warnings &&
            this.data.warnings.length > 0
        );
    }

    get warningItems() {
        if (
            !this.data ||
            !this.data.warnings
        ) {
            return [];
        }

        return this.data.warnings.map(
            (text, idx) => ({
                key: `warn-${idx}`,
                text
            })
        );
    }

    /* ---------------- helpers ---------------- */

    updateClock() {
        this.clockText =
            this.istTime(new Date());
    }

    istTime(d) {
        return new Intl.DateTimeFormat(
            'en-GB',
            {
                timeZone:
                    'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            }
        ).format(d);
    }

    formatTotal(m, totals) {
        const v =
            totals[
                m.key
            ] || 0;

        return m.unit === 'min'
            ? Math.round(
                  v
              ).toLocaleString()
            : Number(v).toLocaleString();
    }

    boardTotal(m, rows) {
        if (m.isRate) {
            const pool =
                qualifiedPool(
                    rows,
                    m,
                    this.currentTier
                );

            const num =
                pool.reduce(
                    (s, r) =>
                        s +
                        (r.metrics[
                            m.numeratorKey
                        ] || 0),
                    0
                );

            const den =
                pool.reduce(
                    (s, r) =>
                        s +
                        (r.metrics[
                            m.denominatorKey
                        ] || 0),
                    0
                );

            return den > 0
                ? `${Math.round(
                      (num / den) *
                          100
                  )}%`
                : '0%';
        }

        const total =
            rows.reduce(
                (s, r) =>
                    s +
                    (r.metrics[
                        m.key
                    ] || 0),
                0
            );

        return m.unit === 'min'
            ? `${Math.round(total)}`
            : `${total}`;
    }

    /* ====================================================================
     * MANAGER / HEAD OVERLAY
     * ================================================================== */

    get overlayTitle() {
        return this.overlayLevel ===
            'head'
            ? 'HEAD PERFORMANCE'
            : 'MANAGER PERFORMANCE';
    }

    get overlayCssClass() {
        return `overlay ${
            this.overlayLevel ===
            'head'
                ? 'overlay-head'
                : 'overlay-manager'
        }`;
    }

    get overlaySubtitle() {
        return this.overlayLevel ===
            'head'
            ? 'Ranked by conversion \u00B7 expanded by manager \u00B7 today \u00B7 IST'
            : 'Ranked by conversion \u00B7 per-caller averages \u00B7 today \u00B7 IST';
    }

    get overlaySubLabel() {
        return this.overlayLevel ===
            'head'
            ? 'Mgrs'
            : 'TLs';
    }

    get overlayRateMetric() {
        return this.data &&
            this.data.metricDefs
            ? this.data.metricDefs.find(
                  (m) => m.isRate
              )
            : null;
    }

    get overlayHasConfigError() {
        return (
            this.overlayVisible &&
            !this.overlayRateMetric
        );
    }

    get overlayConfigErrorMessage() {
        return (
            'This view needs a rate metric (e.g. Cond vs Sched) to rank by, ' +
            'but none is configured. Check GSquareSalesArenaMetric__mdt or ' +
            'GSquareSalesArenaWrapper.cls for a metric with Is_Rate__c = true.'
        );
    }

    get overlayColumns() {
        if (!this.data) {
            return [];
        }

        return orderedMetrics(
            this.data.metricDefs
        ).map((m) => ({
            key: m.key,
            label: m.label
        }));
    }

    get overlayRows() {
        if (
            !this.data ||
            !this.overlayVisible
        ) {
            return [];
        }

        const rm =
            this.overlayRateMetric;

        if (!rm) {
            return [];
        }

        const people =
            this.data.people;

        const defs =
            this.data.metricDefs;

        const level =
            this.overlayLevel;

        const groups = averages(
            people,
            defs,
            level
        ).sort(
            (a, b) =>
                (b.metrics[
                    rm.key
                ] || 0) -
                (a.metrics[
                    rm.key
                ] || 0)
        );

        const out = [];

        groups.forEach((g, i) => {
            out.push(
                this.overlayToRow(
                    g,
                    i + 1,
                    false
                )
            );

            if (level === 'head') {
                const members =
                    people.filter(
                        (p) =>
                            p.headName ===
                            g.name
                    );

                averages(
                    members,
                    defs,
                    'manager'
                )
                    .sort(
                        (a, b) =>
                            (b.metrics[
                                rm.key
                            ] || 0) -
                            (a.metrics[
                                rm.key
                            ] || 0)
                    )
                    .forEach((s) =>
                        out.push(
                            this.overlayToRow(
                                s,
                                null,
                                true
                            )
                        )
                    );
            }
        });

        const totalN =
            groups.reduce(
                (s, g) =>
                    s + g.count,
                0
            );

        if (totalN > 0) {
            const floor = {
                name: 'Floor Total',
                count: totalN,
                subCount: '',
                metrics: {},
                raw: {}
            };

            defs.forEach((m) => {
                floor.raw[m.key] =
                    groups.reduce(
                        (s, g) =>
                            s +
                            (g.raw[
                                m.key
                            ] || 0),
                        0
                    );

                floor.metrics[m.key] =
                    floor.raw[m.key];
            });

            const num =
                groups.reduce(
                    (s, g) =>
                        s +
                        (g.raw[
                            rm.numeratorKey
                        ] || 0),
                    0
                );

            const den =
                groups.reduce(
                    (s, g) =>
                        s +
                        (g.raw[
                            rm.denominatorKey
                        ] || 0),
                    0
                );

            floor.metrics[rm.key] =
                den > 0
                    ? (num / den) *
                      100
                    : 0;

            const row =
                this.overlayToRow(
                    floor,
                    null,
                    false
                );

            row.rowClass =
                'floor-row';

            out.push(row);
        }

        return out;
    }

    overlayToRow(
        g,
        rankNum,
        isSub
    ) {
        const settings =
            this.settings;

        const good =
            settings.rateGoodThreshold ||
            25;

        const bad =
            settings.rateBadThreshold ||
            12;

        const defs =
            this.data.metricDefs;

        return {
            key: `${g.realId || g.name}-${
                isSub ? 'sub' : 'main'
            }`,
            rank: rankNum || '',
            name: isSub
                ? `\u21B3 ${g.name}`
                : g.name,
            subCount:
                g.subCount ===
                undefined
                    ? ''
                    : g.subCount,
            count: g.count,
            rowClass: isSub
                ? 'sub-row'
                : '',
            cells: orderedMetrics(
                defs
            ).map((m) => {
                const v =
                    g.metrics[m.key];

                let cls = 'num';

                if (m.isRate) {
                    cls +=
                        v >= good
                            ? ' best'
                            : v < bad
                            ? ' worst'
                            : '';
                }

                return {
                    key: m.key,
                    cssClass: cls,
                    text: m.isRate
                        ? `${Number(
                              v
                          ).toFixed(1)}%`
                        : `${Math.round(
                              v
                          )}`
                };
            })
        };
    }

    get overlayNote() {
        if (
            !this.data ||
            !this.overlayVisible
        ) {
            return '';
        }

        const field = `${this.overlayLevel}Name`;

        const excluded =
            this.data.people.filter(
                (p) =>
                    !p[field] ||
                    p[field] ===
                        'Unassigned'
            ).length;

        const bits = [];

        if (excluded) {
            bits.push(
                `${excluded} callers excluded (no ${this.overlayLevel} mapped)`
            );
        }

        bits.push(
            'Per-caller averages include zero-activity callers'
        );

        return bits.join(
            '  \u00B7  '
        );
    }
}