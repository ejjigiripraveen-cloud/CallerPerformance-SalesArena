/**
 * =============================================================================
 *  GSquareSalesArenaWrapperWallTV_V2  --  THE SINGLE SOURCE OF TRUTH
 * =============================================================================
 *
 *  EVERY Salesforce object name, field API name, filter value and business rule
 *  used anywhere in the Sales Arena dashboard is declared in THIS FILE ONLY.
 *
 *  To remap a metric to a different field, change it here and nowhere else.
 *  Apex builds its SOQL from these definitions, and the LWC receives the metric
 *  definitions over the wire -- so no field API name is ever written in JS, HTML
 *  or CSS. Changing BOOKING.ownerField below updates the KPI card, the funnel,
 *  the leaderboard, the alerts, the watchlist and both overlays automatically.
 *
 *  ---------------------------------------------------------------------------
 *  UPGRADE PATH: move to Custom Metadata (no deploy needed to remap)
 *  ---------------------------------------------------------------------------
 *  Create GSquareArenaTvMetric__mdt with fields mirroring MetricDef below, then
 *  replace buildMetrics() with a query over that CMDT. The rest of the codebase
 *  needs no change because everything consumes getMetrics(). Kept as Apex here
 *  so the config is unit-testable and version-controlled.
 * =============================================================================
 */
public without sharing class GSquareSalesArenaWrapperWallTV_V2 {

    /* =========================================================================
     * SECTION 1 -- OBJECT API NAMES
     * ====================================================================== */
    public static final String OBJ_USER        = 'User';
    public static final String OBJ_LEAD        = 'Lead';
    public static final String OBJ_SITE_VISIT  = 'Site_Visit__c';
    public static final String OBJ_CALL_DETAIL = 'Call_Detail__c';
    public static final String OBJ_OPPORTUNITY = 'Opportunity';

    /* =========================================================================
     * SECTION 2 -- USER SCOPE + HIERARCHY
     * ====================================================================== */
    public static final String USER_FLD_NAME       = 'Name';
    public static final String USER_FLD_MANAGER_ID = 'ManagerId';   // walked 3x
    public static final String USER_FLD_ACTIVE     = 'IsActive';
    public static final String USER_FLD_PROFILE    = 'Profile.Name';
    public static final String USER_FLD_ZONE       = 'Zone__c';     // confirmed field, used for the independent Zone filter
    public static final String USER_FLD_AVAILABILITY = 'Availability__c'; // confirmed field, used to exclude unavailable users from Critical Alert
    public static final String USER_FLD_CREATED_DATE = 'CreatedDate';    // standard field
    public static final String USER_FLD_PHOTO = 'Profile_Photo_Document_Id__c'; // full ContentDocument URL

    /** USER_FLD_ZONE is a multi-select picklist: 'Chennai;Coimbatore' belongs to both zones. */
    public static List<String> zonesOf(String raw) {
        List<String> out = new List<String>();
        if (String.isBlank(raw)) return out;
        for (String z : raw.split(';')) {
            if (String.isNotBlank(z)) out.add(z.trim());
        }
        return out;
    }

    /** Metrics shown in the TV hero band; the only ones that need month-to-date. */
    public static final List<String> HERO_METRIC_KEYS = new List<String>{ 'allocation', 'svConducted', 'booking' };

    // Critical Alert eligibility: exclude users created within the last N
    // days -- new hires shouldn't be flagged as "critical" before they've
    // had a fair chance to build a baseline. Computed server-side against
    // User.CreatedDate (standard field, no confirmation needed) using Apex's
    // authoritative Date.today(), NOT the browser's local clock.
    public static final Integer NEW_USER_EXCLUSION_DAYS = 45;

    // FTD/MTD toggle -- the only two supported modes. Anything else (null,
    // blank, a typo) falls back to DATE_RANGE_TODAY.
    public static final String DATE_RANGE_TODAY      = 'TODAY';
    public static final String DATE_RANGE_THIS_MONTH = 'THIS_MONTH';

    /**
     * CONFIRMED (2026-08-16) against a real User/Manager export covering 297
     * people. Exact casing matters -- these are the literal Profile.Name values,
     * not the lowercase guess from the originally supplied query.
     *
     * There is no separate "Presales Manager" profile in this org. The recursive
     * 3-hop walk (User -> TL -> TL's manager -> that person's manager) still
     * produces the right shape even though the middle and top of that chain can
     * both carry the 'Presales Head' profile label -- e.g.:
     *   Sharmili -> Sushma Rachel [TL] -> Ragavi R [Presales Head, functions as
     *   the "Manager" tier] -> Mohammed Bilal [Presales Head, functions as the
     *   "Head" tier]
     * This is exactly the profile-agnostic behavior required: the tier is
     * determined by WHERE someone sits in the ManagerId chain, never by their
     * Profile label.
     *
     * Verified resolution rate across all 259 outbound callers in the sample:
     * TL 100%, Manager 98%, Head 98%. The remaining ~2% terminate at people
     * outside this profile scope entirely (e.g. a cross-functional "Marketing
     * Head", or "Tech Support") and correctly fall to Unassigned rather than
     * guessing.
     */
    public static final List<String> USER_PROFILES_IN_SCOPE = new List<String>{
        'Presales outbound',
        'Presales TL',
        'Presales Head'
    };

    /**
     * The Critical Alert popup (Top Performer / Watchlist rotation) must show
     * ONLY actual telecallers -- not the TLs/Heads who are also present in the
     * same flat `people` list (queried alongside callers so ManagerId
     * hierarchy can resolve). Single source of truth here rather than
     * hardcoded in the LWC, so a future profile rename is still a one-line
     * change that reaches every component automatically.
     */
    public static final String ALERT_POPUP_PROFILE = 'Presales outbound';

    /**
     * Test-only seam (audit finding #6). Apex cannot insert a Profile record, so
     * a deterministic test cannot rely on 'Presales outbound' existing in every
     * org. Tests may set this to any Profile name that genuinely exists in the
     * running org (discovered by querying, not hardcoded), and
     * getUserProfilesInScope() will use it instead. Production code must always
     * call getUserProfilesInScope() -- never USER_PROFILES_IN_SCOPE directly --
     * so this seam has zero effect outside a test context.
     */
    @TestVisible
    private static List<String> profileScopeOverrideForTests = null;

    public static List<String> getUserProfilesInScope() {
        return profileScopeOverrideForTests != null ? profileScopeOverrideForTests : USER_PROFILES_IN_SCOPE;
    }

    /**
     * Accounts that pass the profile filter but are not human agents.
     *
     * FIX (audit finding #7): name-only exclusion is fragile -- rename the
     * integration user and it silently stops being excluded, with the bot's
     * call volume flooding back into every leaderboard with no error. Two
     * independent mechanisms are now checked (EXCLUDED_USER_NAMES below, and
     * EXCLUDED_USER_PROFILES): a record is excluded if it matches EITHER.
     *
     * This is a partial fix, disclosed rather than hidden: I do not have
     * visibility into whether this org already has a dedicated Integration/
     * System-account Profile or a custom classification field, and the audit
     * explicitly said not to invent a new field without confirming one is
     * needed. EXCLUDED_USER_PROFILES is provided as the stable mechanism to use
     * the moment that Profile name is confirmed -- add it there and the name
     * match becomes a redundant safety net rather than the only defense.
     */
    public static final Set<String> EXCLUDED_USER_NAMES = new Set<String>{
        'SlashRTC | GSquare',   // IVR integration user: ~32% of all call volume
        'Automated Process',
        'ADMIN',
        'Common Bucket User',
        'Land Acquistion',      // spelling as it exists in the org
        'Recovery_Presales_TN',
        'Tech Support'
    };

    /**
     * Preferred, stable exclusion mechanism -- populate once a real Integration/
     * System-account Profile name is confirmed for this org (e.g. 'Integration
     * User' or similar). Empty by default since no such profile was confirmed
     * during this build.
     */
    public static final Set<String> EXCLUDED_USER_PROFILES = new Set<String>{
    };

    public static final String UNASSIGNED = 'Unassigned';

    /* =========================================================================
     * SECTION 3 -- METRIC DEFINITIONS
     * ====================================================================== */

    /** One metric = one row of config. Nothing about a metric lives anywhere else. */
    public class MetricDef {
        public String  key;             // stable id used by Apex + LWC
        public String  label;           // UI label
        public String  icon;            // UI icon
        public String  unit;            // UI suffix
        public Integer displayOrder;    // canonical funnel order, used everywhere
        public Boolean showInFunnel;    // top KPI strip
        public Boolean showInBoards;    // leaderboards
        public Boolean isRate;          // derived ratio, not a queryable field

        // --- source mapping (ignored when isRate = true) ---
        public String  objectApi;
        public String  ownerField;      // lookup(User) that attributes the record
        public String  ownerFieldAlt;   // fallback owner when primary is null
        public String  dateField;       // date/datetime field the TODAY filter uses
        public String  statusField;
        public List<String> statusValues;   // empty = no status filter
        public String  aggregateType;   // 'COUNT' or 'SUM'
        public String  valueField;      // field summed when aggregateType = 'SUM'
        // Each entry is ONE condition in the strict "Field OP Value" shape below,
        // never a raw SOQL fragment. Validated + built into SOQL by
        // SalesArenaService.buildSafeExtraFilter() -- see that method for the
        // full allow-list (audit finding #8: CMDT must not accept arbitrary SOQL).
        public List<String> extraFilterConditions;
        public Decimal divisor;         // applied post-aggregation (e.g. sec->min)

        // --- rate config (only when isRate = true) ---
        public String  numeratorKey;
        public String  denominatorKey;
        public Map<String, Integer> minVolumeByTier; // qualifier per tier
    }

    private static List<MetricDef> metricCache;
    private static List<String> configWarnings = new List<String>();

    /** Warnings produced while resolving metric config (e.g. malformed CMDT records). */
    public static List<String> getConfigWarnings() {
        getMetrics(); // ensure resolution has run
        return configWarnings;
    }

    /**
     * Returns the metric definitions: hardcoded defaults, with any
     * GSquareArenaTvMetric__mdt records applied as an ADDITIVE override BY KEY.
     *
     * FIX (audit finding #4): the previous version treated "any CMDT record
     * exists" as "replace the entire default set", so a single CMDT record
     * created to override one metric silently deleted the other five. CMDT now
     * only overrides the specific metric key(s) it defines; every other default
     * metric is untouched. A CMDT record can also define a brand-new key not in
     * the hardcoded set, which is added alongside the defaults.
     *
     * Malformed CMDT records (missing required fields, invalid rate config,
     * duplicate keys) are skipped individually with a warning rather than
     * corrupting the whole metric set -- see mergeOneOverride().
     */
    public static List<MetricDef> getMetrics() {
        if (metricCache == null) {
            List<GSquareArenaTvMetric__mdt> overrides = [
                SELECT Metric_Key__c, Metric_Label__c, Unit__c, Display_Order__c,
                       Show_In_Funnel__c, Show_In_Boards__c, Is_Rate__c,
                       Object_API__c, Owner_Field_API__c, Owner_Field_Alt__c,
                       Date_Field_API__c, Status_Field_API__c, Status_Values__c,
                       Aggregate_Type__c, Value_Field_API__c, Extra_Filter__c,
                       Divisor__c, Numerator_Key__c, Denominator_Key__c,
                       Min_Volume_JSON__c, DeveloperName
                FROM GSquareArenaTvMetric__mdt
                ORDER BY DeveloperName ASC
            ];
            metricCache = mergeMetrics(buildMetrics(), overrides);
        }
        return metricCache;
    }

    /**
     * The additive-merge logic itself, extracted as a pure function of its
     * inputs so it is unit-testable WITHOUT inserting real
     * GSquareArenaTvMetric__mdt records -- Custom Metadata Types cannot be
     * created via DML in an Apex test (a real platform constraint, confirmed
     * while writing SalesArenaControllerTest), so testing this logic requires
     * accepting the override list as a parameter rather than querying it
     * internally. Tests build in-memory (uninserted) `new
     * GSquareArenaTvMetric__mdt(...)` instances and pass them directly here.
     */
    @TestVisible
    private static List<MetricDef> mergeMetrics(List<MetricDef> defaults, List<GSquareArenaTvMetric__mdt> overrides) {
        configWarnings = new List<String>();
        Map<String, MetricDef> byKey = new Map<String, MetricDef>();
        for (MetricDef d : defaults) byKey.put(d.key, d);

        Set<String> seenKeys = new Set<String>();
        for (GSquareArenaTvMetric__mdt r : overrides) {
            if (String.isBlank(r.Metric_Key__c)) {
                configWarnings.add('CMDT record ' + r.DeveloperName + ' skipped: Metric_Key__c is blank.');
                continue;
            }
            if (seenKeys.contains(r.Metric_Key__c)) {
                configWarnings.add('Duplicate CMDT metric key "' + r.Metric_Key__c + '" on '
                    + r.DeveloperName + ' ignored; first definition (by DeveloperName) wins.');
                continue;
            }
            seenKeys.add(r.Metric_Key__c);

            MetricDef d = mergeOneOverride(r, byKey.get(r.Metric_Key__c));
            if (d != null) byKey.put(r.Metric_Key__c, d);
        }

        List<MetricDef> merged = byKey.values();
        merged.sort(new MetricOrderComparator());
        return merged;
    }

    /**
     * Merges one CMDT record onto an existing default (if any) or builds a new
     * MetricDef from scratch. Returns null (and records a warning) if the
     * result would be structurally invalid -- this is what stops one bad
     * record from producing a metric that later crashes SalesArenaService.
     */
    private static MetricDef mergeOneOverride(GSquareArenaTvMetric__mdt r, MetricDef existing) {
        MetricDef d = existing != null ? cloneMetric(existing) : new MetricDef();
        d.key = r.Metric_Key__c;

        if (r.Metric_Label__c != null)        d.label = r.Metric_Label__c;
        if (r.Unit__c != null)                d.unit = r.Unit__c;
        if (r.Display_Order__c != null)       d.displayOrder = Integer.valueOf(r.Display_Order__c);
        // FIX (found in final independent review): Show_In_Funnel__c,
        // Show_In_Boards__c, Is_Rate__c were originally Checkbox fields.
        // Salesforce Checkbox fields can NEVER be null -- they always hold
        // true/false per the field's configured default -- so
        // "if (r.X != null)" was ALWAYS true, meaning any partial CMDT
        // override touching an EXISTING metric silently reset these three
        // fields to their field-level defaults regardless of admin intent,
        // undermining the "truly additive" merge guarantee for exactly these
        // fields. Converted to Picklist ('true'/'false'/blank) in the CMDT
        // schema, where blank genuinely represents "not overridden" -- Apex
        // now checks isNotBlank(), not != null.
        if (String.isNotBlank(r.Show_In_Funnel__c)) d.showInFunnel = r.Show_In_Funnel__c == 'true';
        if (String.isNotBlank(r.Show_In_Boards__c)) d.showInBoards = r.Show_In_Boards__c == 'true';
        if (String.isNotBlank(r.Is_Rate__c))        d.isRate       = r.Is_Rate__c == 'true';
        if (r.Object_API__c != null)          d.objectApi = r.Object_API__c;
        if (r.Owner_Field_API__c != null)     d.ownerField = r.Owner_Field_API__c;
        if (r.Owner_Field_Alt__c != null)     d.ownerFieldAlt = r.Owner_Field_Alt__c;
        if (r.Date_Field_API__c != null)      d.dateField = r.Date_Field_API__c;
        if (r.Status_Field_API__c != null)    d.statusField = r.Status_Field_API__c;
        if (r.Aggregate_Type__c != null)      d.aggregateType = r.Aggregate_Type__c;
        if (r.Value_Field_API__c != null)     d.valueField = r.Value_Field_API__c;
        if (r.Extra_Filter__c != null) {
            // CMDT stores conditions pipe-separated, e.g. "Amount__c >= 5000|Stage__c != 'Lost'".
            // Each is validated independently at query-build time -- see
            // SalesArenaService.buildSafeExtraFilter(). No raw SOQL is ever accepted.
            List<String> conds = new List<String>();
            for (String c : r.Extra_Filter__c.split('\\|')) {
                if (String.isNotBlank(c)) conds.add(c.trim());
            }
            d.extraFilterConditions = conds;
        }
        if (r.Divisor__c != null)             d.divisor = r.Divisor__c;
        if (r.Numerator_Key__c != null)       d.numeratorKey = r.Numerator_Key__c;
        if (r.Denominator_Key__c != null)     d.denominatorKey = r.Denominator_Key__c;
        if (r.Status_Values__c != null) {
            List<String> vals = new List<String>();
            for (String v : r.Status_Values__c.split(',')) vals.add(v.trim());
            d.statusValues = vals;
        }
        if (r.Min_Volume_JSON__c != null) {
            try {
                Map<String, Object> raw = (Map<String, Object>) JSON.deserializeUntyped(r.Min_Volume_JSON__c);
                Map<String, Integer> mv = new Map<String, Integer>();
                for (String k : raw.keySet()) mv.put(k, Integer.valueOf(raw.get(k)));
                d.minVolumeByTier = mv;
            } catch (Exception e) {
                configWarnings.add('CMDT "' + r.DeveloperName + '": Min_Volume_JSON__c is not valid '
                    + 'JSON, ignored: ' + e.getMessage());
            }
        }

        // Validate the RESULT is structurally sound before accepting it. This is
        // the guard that stops SalesArenaService.assemble() from hitting a null
        // numerator/denominator dereference (audit finding #5's root cause, at
        // the config layer where it should be caught first).
        if (String.isBlank(d.label) || d.displayOrder == null) {
            configWarnings.add('CMDT "' + r.DeveloperName + '" for key "' + d.key
                + '" is missing label/displayOrder and was rejected.');
            return existing; // keep the prior default rather than losing the metric entirely
        }
        if (d.isRate == true) {
            if (String.isBlank(d.numeratorKey) || String.isBlank(d.denominatorKey)) {
                configWarnings.add('CMDT "' + r.DeveloperName + '" for key "' + d.key
                    + '" is a rate metric missing numerator/denominator key and was rejected.');
                return existing;
            }
        } else if (existing == null) {
            // A brand-new (non-rate) metric key needs the minimum fields to be queryable
            if (String.isBlank(d.objectApi) || String.isBlank(d.ownerField) || String.isBlank(d.aggregateType)) {
                configWarnings.add('CMDT "' + r.DeveloperName + '" for new key "' + d.key
                    + '" is missing objectApi/ownerField/aggregateType and was rejected.');
                return null;
            }
        }
        return d;
    }

    private static MetricDef cloneMetric(MetricDef src) {
        MetricDef d = new MetricDef();
        d.key = src.key; d.label = src.label; d.icon = src.icon; d.unit = src.unit;
        d.displayOrder = src.displayOrder; d.showInFunnel = src.showInFunnel;
        d.showInBoards = src.showInBoards; d.isRate = src.isRate;
        d.objectApi = src.objectApi; d.ownerField = src.ownerField; d.ownerFieldAlt = src.ownerFieldAlt;
        d.dateField = src.dateField; d.statusField = src.statusField;
        d.statusValues = src.statusValues == null ? null : src.statusValues.clone();
        d.aggregateType = src.aggregateType; d.valueField = src.valueField;
        d.extraFilterConditions = src.extraFilterConditions == null ? null : src.extraFilterConditions.clone();
        d.divisor = src.divisor;
        d.numeratorKey = src.numeratorKey; d.denominatorKey = src.denominatorKey;
        d.minVolumeByTier = src.minVolumeByTier == null ? null : src.minVolumeByTier.clone();
        return d;
    }

    /** Keeps merged metrics in canonical funnel order. */
    private class MetricOrderComparator implements Comparator<MetricDef> {
        public Integer compare(MetricDef a, MetricDef b) {
            return a.displayOrder - b.displayOrder;
        }
    }

    public static MetricDef getMetric(String key) {
        for (MetricDef m : getMetrics()) if (m.key == key) return m;
        return null;
    }

    /**
     * @TestVisible so tests can obtain the PURE hardcoded defaults directly,
     * rather than going through getMetrics() (which queries the real
     * GSquareArenaTvMetric__mdt table -- Custom Metadata records are NOT
     * transaction-isolated the way normal test data is, so a test that used
     * getMetrics() as its "defaults" baseline would silently depend on
     * whatever CMDT records happen to actually exist in the deploy target,
     * violating the "don't depend on current org state" requirement).
     */
    @TestVisible
    private static List<MetricDef> buildMetrics() {
        List<MetricDef> defs = new List<MetricDef>();

        // ---------------------------------------------------------------- 1
        MetricDef allocation   = new MetricDef();
        allocation.key           = 'allocation';
        allocation.label         = 'Allocation';
        allocation.icon          = 'clipboard';
        allocation.unit          = '';
        allocation.displayOrder  = 1;
        allocation.showInFunnel  = true;
        allocation.showInBoards  = true;
        allocation.isRate        = false;
        allocation.objectApi     = OBJ_LEAD;
        allocation.ownerField    = 'Qualified_By__c';
        allocation.dateField     = 'Qualified_On__c';
        allocation.statusValues  = new List<String>();
        allocation.aggregateType = 'COUNT';
        defs.add(allocation);

        // ---------------------------------------------------------------- 2
        MetricDef svSched   = new MetricDef();
        svSched.key           = 'svScheduled';
        svSched.label         = 'SV Scheduled';
        svSched.icon          = 'calendar';
        svSched.unit          = '';
        svSched.displayOrder  = 2;
        svSched.showInFunnel  = true;
        svSched.showInBoards  = true;
        svSched.isRate        = false;
        svSched.objectApi     = OBJ_SITE_VISIT;
        svSched.ownerField    = 'Scheduled_By__c';
        svSched.dateField     = 'CreatedDate';
        svSched.statusField   = 'Status__c';
        // 'Reschedule' counts as scheduled -- confirmed business decision
        svSched.statusValues  = new List<String>{ 'Scheduled', 'Reschedule' };
        svSched.aggregateType = 'COUNT';
        defs.add(svSched);

        // ---------------------------------------------------------------- 3
        MetricDef svCond   = new MetricDef();
        svCond.key           = 'svConducted';
        svCond.label         = 'SV Conducted';
        svCond.icon          = 'home';
        svCond.unit          = '';
        svCond.displayOrder  = 3;
        svCond.showInFunnel  = true;
        svCond.showInBoards  = true;
        svCond.isRate        = false;
        svCond.objectApi     = OBJ_SITE_VISIT;
        // CONFIRMED business decision (2026-08): a conducted visit is credited to
        // whoever SCHEDULED it, not Conducted_By__c / SV_Conducted_By__c (both
        // exist on the object but are intentionally not used). If a visit is
        // handed off between agents, credit stays with the original scheduler.
        svCond.ownerField    = 'Scheduled_By__c';
        svCond.dateField     = 'Conducted_On__c';
        svCond.statusField   = 'Status__c';
        svCond.statusValues  = new List<String>{ 'Conducted' };
        svCond.aggregateType = 'COUNT';
        defs.add(svCond);

        // ---------------------------------------------------------------- 4
        MetricDef rate   = new MetricDef();
        rate.key             = 'condVsSched';
        rate.label           = 'Cond vs Sched';
        rate.icon            = 'bolt';
        rate.unit            = '%';
        rate.displayOrder    = 4;
        rate.showInFunnel    = false;   // rendered as a funnel connector instead
        // Removed from the leaderboard boards on request. This does NOT remove
        // it from: the funnel connector (that's showInFunnel/isRate, untouched),
        // or the Manager/Head overlay's ranking metric (that uses
        // metricDefs.find(m => m.isRate), also untouched). It only stops it from
        // appearing as its own board in the rotating leaderboard, and -- as a
        // natural consequence of boardMetrics() being the pool Dominant Team
        // draws from -- it no longer counts toward a team's Dominant Team win tally.
        rate.showInBoards    = false;
        rate.isRate          = true;
        rate.numeratorKey    = 'svConducted';
        rate.denominatorKey  = 'svScheduled';
        // Minimum denominator volume, else 1-of-1 = 100% tops the leaderboard
        rate.minVolumeByTier = new Map<String, Integer>{
            'individual' => 5, 'team' => 5, 'tl' => 20, 'manager' => 30, 'head' => 50
        };
        defs.add(rate);

        // ---------------------------------------------------------------- 5
        MetricDef booking   = new MetricDef();
        booking.key           = 'booking';
        booking.label         = 'Booking';
        booking.icon          = 'trophy';
        booking.unit          = '';
        booking.displayOrder  = 5;
        booking.showInFunnel  = true;
        booking.showInBoards  = true;
        booking.isRate        = false;
        booking.objectApi     = OBJ_OPPORTUNITY;
        booking.ownerField    = 'Presales_Owner__c';
        booking.ownerFieldAlt = 'SV_User__c';        // fallback, never both
        booking.dateField     = 'Booking_Date__c';
        booking.statusField   = 'StageName';
        booking.statusValues  = new List<String>();  // exclusion handled below
        booking.extraFilterConditions = new List<String>{
            'Total_Receipts__c >= ' + BOOKING_MIN_RECEIPTS,
            'StageName != \'' + BOOKING_EXCLUDED_STAGE + '\''
        };
        booking.aggregateType = 'COUNT';
        defs.add(booking);

        // ---------------------------------------------------------------- 6
        MetricDef talktime   = new MetricDef();
        talktime.key           = 'talktime';
        talktime.label         = 'Talktime';
        talktime.icon          = 'call';
        talktime.unit          = 'min';
        talktime.displayOrder  = 6;
        talktime.showInFunnel  = false;   // removed from KPI strip by design
        talktime.showInBoards  = true;
        talktime.isRate        = false;
        talktime.objectApi     = OBJ_CALL_DETAIL;
        talktime.ownerField    = 'OwnerId';
        talktime.dateField     = 'CreatedDate';
        talktime.statusField   = 'Status__c';
        talktime.statusValues  = CALL_ANSWERED_STATUSES;
        talktime.aggregateType = 'SUM';
        // CONFIRMED (2026-08): Duration__c is the live field populated by the
        // dialer integration. Call_Duration__c and Duration_HH_MM_SS__c exist on
        // the object but are legacy/unused -- intentionally not used here.
        talktime.valueField    = 'Duration__c';
        talktime.divisor       = 60;      // Duration__c is SECONDS -> display minutes
        defs.add(talktime);

    // ---------------------------------------------------------------- 7
// Total calls DIALED today, regardless of outcome -- deliberately NO
// statusField/statusValues filter here (unlike talktime, which only
// sums ANSWER/Call Complete/TRUE). "Made 10 calls" should count every
// attempt, connected or not; talktime only measures connected time.
MetricDef callsMade   = new MetricDef();
callsMade.key           = 'callsMade';
callsMade.label         = 'Calls Made';
callsMade.icon          = 'phone';
callsMade.unit          = '';
callsMade.displayOrder  = 7;
callsMade.showInFunnel  = false;
callsMade.showInBoards  = false;  // eligibility filter only, not a leaderboard
callsMade.isRate        = false;
callsMade.objectApi     = OBJ_CALL_DETAIL;
callsMade.ownerField    = 'OwnerId';
callsMade.dateField     = 'CreatedDate';
callsMade.statusValues  = new List<String>(); // no status filter -- count every dial
callsMade.aggregateType = 'COUNT';
defs.add(callsMade);

        return defs;
    }



    /* =========================================================================
     * SECTION 4 -- BUSINESS RULE CONSTANTS
     * ====================================================================== */

    /** Opportunity qualifies as a booking at or above this receipt total. */
    public static final Decimal BOOKING_MIN_RECEIPTS = 90000;

    /** Stage excluded from bookings. */
    public static final String BOOKING_EXCLUDED_STAGE = 'Cancelled';

    /**
     * Call_Detail__c.Status__c values that count as an answered ("Connected") call.
     *
     * CONFIRMED (2026-08-16) against your full Status__c -> Remark business
     * definition table -- this was the highest-risk unverified mapping in the
     * whole project and is now resolved from source, not guessed.
     *
     * Correcting what I had before: the boolean-shaped value is 'TRUE' (all caps),
     * not 'True' as I had it. That casing mismatch alone would have silently
     * dropped every "TRUE" record from talktime -- 10,407 of 68,961 daily call
     * records (15%) in the original sample -- with no error thrown. This is
     * exactly the failure mode the earlier flag was trying to prevent.
     *
     * 'Completed' remains correctly excluded -- confirmed as its own distinct,
     * Not Connected value, separate from 'Call Complete'. My original exclusion
     * of it was correct; only the 'True'/'TRUE' casing needed fixing.
     *
     * Full confirmed table, for reference (Connected / Not Connected):
     *   ANSWER          -> Connected        BUSY             -> Not Connected
     *   Call Complete   -> Connected        CANCEL           -> Not Connected
     *   TRUE            -> Connected        Completed        -> Not Connected
     *                                       CONNECTING       -> Not Connected
     *                                       Customer Busy    -> Not Connected
     *                                       Executive Busy   -> Not Connected
     *                                       MISSED           -> Not Connected
     *                                       NO ANSWER        -> Not Connected
     *                                       NOANSWER         -> Not Connected
     *                                       Originate        -> Not Connected
     *                                       FALSE            -> Not Connected
     */
    public static final List<String> CALL_ANSWERED_STATUSES = new List<String>{
        'ANSWER',
        'Call Complete',
        'TRUE'
    };

    /**
     * Call Count and Talk Time must NOT count records matching:
     *   Source_Of_Call__c = 'g talk' AND Call_Type__c = 'inbound call'
     * Confirmed business rule (2026-08-29) -- G-Talk inbound calls are not
     * genuine outbound telecaller activity and would inflate both metrics.
     * Applied as a single "NOT (A AND B)" clause in
     * GSquareSalesArenaServiceWallTV_V2.loadAggregate() for exactly the metric keys
     * below, regardless of FTD/MTD mode -- this is a data-quality exclusion,
     * not a date-range concern, so it applies to both `metrics` and
     * `rangeMetrics` queries alike.
     *
     * ASSUMPTION FLAGGED, NOT CONFIRMED: the exact stored casing of
     * Source_Of_Call__c ('g talk') and Call_Type__c ('inbound call') was
     * given lowercase as-is and has not been separately verified against the
     * live picklist values the way CALL_ANSWERED_STATUSES was. If either
     * field actually stores different casing (e.g. 'G Talk', 'Inbound Call'),
     * this filter will silently exclude zero records -- confirm in Setup ->
     * Object Manager -> Call_Detail__c -> Fields, or against real data.
     */
    public static final String CALL_DETAIL_FLD_SOURCE_OF_CALL = 'Source_Of_Call__c';
    public static final String CALL_DETAIL_FLD_CALL_TYPE      = 'Call_Type__c';
    public static final String GTALK_SOURCE_OF_CALL_VALUE     = 'g talk';
    public static final String GTALK_INBOUND_CALL_TYPE_VALUE  = 'inbound call';
    public static final Set<String> GTALK_INBOUND_EXCLUDED_METRIC_KEYS = new Set<String>{
        'callsMade', 'talktime'
    };

    /** Lead statuses treated as live pipeline. */
    public static final List<String> ACTIVE_LEAD_STATUSES = new List<String>{
        'Incoming', 'Sales Prospect', 'Qualified'
    };

    public static final String LEAD_FLD_STATUS     = 'Status';
    public static final String LEAD_FLD_SV_USER    = 'SV_User__c';   // active leads owner

    /* =========================================================================
     * SECTION 5 -- WATCHLIST / ALERT THRESHOLDS
     * ====================================================================== */
    /** A caller is watchlisted when below average on at least this many metrics. */
    public static final Integer WATCHLIST_MIN_WEAK_METRICS = 3;
    /** Cap so the watchlist stays an exception report, not a census. */
    public static final Integer WATCHLIST_MAX_ENTRIES = 25;
    /** Zero-metric count at or above which an alert escalates to critical. */
    public static final Integer ALERT_CRITICAL_ZERO_COUNT = 3;

    /* =========================================================================
     * SECTION 6 -- DISPLAY / ROTATION SETTINGS
     * ====================================================================== */
    public static final Integer TIER_SECONDS        = 10;
    public static final Integer MODE_FLIP_SECONDS   = 5;
    public static final Integer BOARD_ROW_LIMIT     = 10;
    public static final Integer ALERT_HOLD_SECONDS  = 7;
    public static final Integer OVERLAY_HOLD_SECONDS = 25;
    public static final Integer OVERLAY_MANAGER_EVERY_MINUTES = 20;
    public static final Integer OVERLAY_HEAD_EVERY_MINUTES    = 30;
    public static final Integer REFRESH_INTERVAL_SECONDS      = 180;

    /** Absolute grading for the rate metric (not peer-relative). */
    public static final Decimal RATE_GOOD_THRESHOLD = 25;
    public static final Decimal RATE_BAD_THRESHOLD  = 12;

    /* =========================================================================
     * DTO CLASSES (merged from the original SalesArenaDTO.cls) -- these are the
     * data-transfer objects shipped to the LWC. Kept in the same file as the
     * config/metric definitions per the requested Wrapper/Service/Controller
     * three-class structure: Wrapper = "everything describing the shape and
     * mapping of the data", Service = "how to get and compute it",
     * Controller = "the thin @AuraEnabled entry point".
     * ====================================================================== */



    /** Metric definition shipped to the LWC so the UI renders from config. */
    public class MetricInfo {
        @AuraEnabled public String  key;
        @AuraEnabled public String  label;
        @AuraEnabled public String  icon;
        @AuraEnabled public String  unit;
        @AuraEnabled public Integer displayOrder;
        @AuraEnabled public Boolean showInFunnel;
        @AuraEnabled public Boolean showInBoards;
        @AuraEnabled public Boolean isRate;
        @AuraEnabled public String  numeratorKey;
        @AuraEnabled public String  denominatorKey;
        @AuraEnabled public Map<String, Integer> minVolumeByTier;

        public MetricInfo(GSquareSalesArenaWrapperWallTV_V2.MetricDef d) {
            this.key             = d.key;
            this.label           = d.label;
            this.icon            = d.icon;
            this.unit            = d.unit;
            this.displayOrder    = d.displayOrder;
            this.showInFunnel    = d.showInFunnel  == true;
            this.showInBoards    = d.showInBoards  == true;
            this.isRate          = d.isRate        == true;
            this.numeratorKey    = d.numeratorKey;
            this.denominatorKey  = d.denominatorKey;
            this.minVolumeByTier = d.minVolumeByTier;
        }
    }

    /** One caller, with hierarchy resolved and all metrics keyed by metric key. */
    public class PersonDTO {
        @AuraEnabled public Id     userId;
        @AuraEnabled public String name;
        @AuraEnabled public String profileName;  // this person's OWN profile -- NOT their tier in the hierarchy
        @AuraEnabled public String zone;         // Zone__c -- independent filter, not part of the hierarchy cascade
        @AuraEnabled public Boolean availability; // Availability__c -- false excludes this person from Critical Alert / Watchlist eligibility
        @AuraEnabled public Boolean tenureEligible; // true if User.CreatedDate is older than NEW_USER_EXCLUSION_DAYS -- computed server-side, Critical Alert eligibility only
        @AuraEnabled public Id     tlId;
        @AuraEnabled public String tlName;
        @AuraEnabled public Id     managerId;
        @AuraEnabled public String managerName;
        @AuraEnabled public Id     headId;
        @AuraEnabled public String headName;
        @AuraEnabled public String initials;
        @AuraEnabled public String photoUrl;      // rendition URL, or null -> initials
        @AuraEnabled public Map<String, Decimal> mtdMetrics = new Map<String, Decimal>();  // hero metrics, month to date
        @AuraEnabled public Map<String, Decimal> metrics = new Map<String, Decimal>();

        public PersonDTO(Id userId, String name) {
            this.userId = userId;
            this.name   = name;
            this.tlName      = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
            this.managerName = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
            this.headName    = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
        }

        public void add(String metricKey, Decimal value) {
            Decimal cur = metrics.containsKey(metricKey) ? metrics.get(metricKey) : 0;
            metrics.put(metricKey, cur + value);
        }

        public void addMtd(String metricKey, Decimal value) {
            Decimal cur = mtdMetrics.containsKey(metricKey) ? mtdMetrics.get(metricKey) : 0;
            mtdMetrics.put(metricKey, cur + value);
        }
    }

    /**
     * One TL's entry in the Team Spotlight rotation order. Carries the real
     * Salesforce Id, not just the display name -- two different TLs sharing an
     * identical Name is entirely possible at 300+ users, and the LWC needs the
     * Id to correctly select "this specific TL's roster", not "everyone whose
     * TL happens to have this display name" (a distinct instance of the same
     * root-cause bug fixed in metricEngineLib.js's aggregate() grouping).
     */
    public class TeamRosterEntry {
        @AuraEnabled public Id     tlId;
        @AuraEnabled public String tlName;
        @AuraEnabled public Integer teamSize;
    }

    /** Full dashboard payload -- one round trip serves every component. */
    public class ZoneRaceEntry {
        @AuraEnabled public String  zone;
        @AuraEnabled public Decimal svConducted;
        public ZoneRaceEntry(String zone, Decimal svConducted) {
            this.zone = zone;
            this.svConducted = svConducted;
        }
    }

    /** Typical-day curves for this zone (and its TLs) on today's IST weekday. */
    public class BaselineDTO {
        @AuraEnabled public Map<String, List<Decimal>> hourly = new Map<String, List<Decimal>>();  // metricKey -> 24 values
        @AuraEnabled public Map<String, Decimal> lastMonthToDate = new Map<String, Decimal>();      // metricKey -> value
        @AuraEnabled public Map<String, List<Decimal>> tlHourly = new Map<String, List<Decimal>>(); // tlId -> svConducted, 24 values
    }

    public class DashboardDTO {
        @AuraEnabled public List<MetricInfo>      metricDefs;
        @AuraEnabled public List<PersonDTO>       people;
        @AuraEnabled public Map<String, Decimal>  totals;
        @AuraEnabled public List<TeamRosterEntry> teamRoster;   // team spotlight order, keyed by real Id
        @AuraEnabled public Datetime              lastUpdated;
        @AuraEnabled public String                zone;
        @AuraEnabled public Boolean               zoneConfigured;
        @AuraEnabled public Map<String, Decimal>  mtdTotals;
        @AuraEnabled public List<ZoneRaceEntry>   zoneRace;
        @AuraEnabled public BaselineDTO           baseline;
        @AuraEnabled public Map<String, Integer>  tlTeamSizes;  // tlId -> callers across ALL zones
        @AuraEnabled public Map<String, Object>   settings;
        @AuraEnabled public List<String>          warnings;     // surfaced in the UI
    }

}