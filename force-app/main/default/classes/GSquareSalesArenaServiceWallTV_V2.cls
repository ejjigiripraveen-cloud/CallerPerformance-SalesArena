/**
 * =============================================================================
 *  GSquareSalesArenaServiceWallTV_V2
 * =============================================================================
 *  Builds every SOQL statement dynamically from GSquareSalesArenaWrapperWallTV_V2.MetricDef.
 *  No field API name is written literally in this class -- remapping a metric in
 *  the config changes the query here with no edit.
 *
 *  PERFORMANCE: all metrics use aggregate SOQL (GROUP BY owner). Call_Detail__c
 *  alone returns ~69,000 rows/day at this floor size; returning raw records would
 *  exceed heap. Aggregates return one row per user instead.
 *
 *  ATTRIBUTION: keyed on User Id, never on Name. The prototype matched on names
 *  because it consumed a CSV export; matching on Id removes an entire class of
 *  duplicate/renamed-user bugs.
 * =============================================================================
 */
public without sharing class GSquareSalesArenaServiceWallTV_V2 {

    private Map<Id, GSquareSalesArenaWrapperWallTV_V2.PersonDTO> peopleById = new Map<Id, GSquareSalesArenaWrapperWallTV_V2.PersonDTO>();
    private Map<Id, Id>     managerIdByUser  = new Map<Id, Id>();
    private Map<Id, String> nameById         = new Map<Id, String>();
    private List<String>    warnings         = new List<String>();

    private String zone;                                    // null = TV page not configured
    private Map<Id, String> photoRawByUser = new Map<Id, String>();
    private Map<Id, List<String>> zonesByUser = new Map<Id, List<String>>();   // every user's seating groups, for the race
    // records counted per metric key, so a booking credited to two people is one in the zone total
    private Map<String, Set<Id>> distinctToday = new Map<String, Set<Id>>();
    private Map<String, Set<Id>> distinctMtd = new Map<String, Set<Id>>();
    private Map<String, Integer> tlTeamSizes = new Map<String, Integer>();

    /* ---------------------------------------------------------------------
     * ENTRY POINT -- one zone TV. `metrics` = today; `mtdMetrics` = this
     * month, hero metrics only. TODAY / THIS_MONTH literals use the running
     * user's timezone, so the shared TV user must be on Asia/Kolkata.
     * ------------------------------------------------------------------ */
    public GSquareSalesArenaWrapperWallTV_V2.DashboardDTO build(String zoneParam) {
        // the TV shows a seating group; an older page preset with a raw zone maps to its group
        zone = GSquareSalesArenaWrapperWallTV_V2.resolveZoneGroup(zoneParam);
        if (zone == null) return assemble();

        loadUsers();
        Set<String> hero = new Set<String>(GSquareSalesArenaWrapperWallTV_V2.HERO_METRIC_KEYS);
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef def : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
            if (def.isRate == true) continue;             // derived, not queried
            Boolean withMtd = hero.contains(def.key);
            if (def.key == 'booking') {
                loadBookings(def, GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_TODAY, false);
                if (withMtd) loadBookings(def, GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_THIS_MONTH, true);
                continue;
            }
            loadAggregate(def, GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_TODAY, false);
            if (withMtd) loadAggregate(def, GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_THIS_MONTH, true);
        }
        resolveHierarchy();
        loadPhotos();
        loadAllZoneUsers();
        return assemble();
    }

    /* ---------------------------------------------------------------------
     * 1. USER SCOPE + HIERARCHY SOURCE
     * ------------------------------------------------------------------ */
    /** 'a','b' for a SOQL INCLUDES list (bind variables are not reliable inside INCLUDES). */
    private static String quotedList(List<String> values) {
        List<String> out = new List<String>();
        for (String v : values) out.add('\'' + String.escapeSingleQuotes(v) + '\'');
        return String.join(out, ',');
    }

    private void loadUsers() {
        String soql =
            'SELECT Id, ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_NAME +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_MANAGER_ID +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PROFILE +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_AVAILABILITY +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_CREATED_DATE +
            ', ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PHOTO +
            ' FROM ' + GSquareSalesArenaWrapperWallTV_V2.OBJ_USER +
            ' WHERE ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ACTIVE + ' = true' +
            ' AND '   + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PROFILE + ' IN :profiles' +
            // Gsquare = everyone; otherwise INCLUDES (multi-select) anyone seated in any zone of this group
            (GSquareSalesArenaWrapperWallTV_V2.isAllZones(zone) ? '' :
                ' AND ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE + ' INCLUDES (' + quotedList(GSquareSalesArenaWrapperWallTV_V2.zonesInGroup(zone)) + ')') +
            ' WITH SECURITY_ENFORCED';

        // getUserProfilesInScope() (not the raw constant) so tests can override
        // with a Profile that genuinely exists in the running org.
        List<String> profiles = GSquareSalesArenaWrapperWallTV_V2.getUserProfilesInScope();

        // Computed ONCE, server-side, using Apex's authoritative clock --
        // not recomputed per-row, and never relies on the browser's local
        // date/time the way a client-side check would.
        Date tenureCutoff = Date.today().addDays(-GSquareSalesArenaWrapperWallTV_V2.NEW_USER_EXCLUSION_DAYS);

        for (SObject so : Database.query(soql)) {
            Id     uid  = (Id) so.get('Id');
            String nm   = (String) so.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_NAME);
            // Dotted relationship fields are not readable via SObject.get('Profile.Name')
            // -- that only works for fields directly on the queried object. The parent
            // record must be fetched as its own SObject first.
            SObject profileRec = so.getSObject('Profile');
            String prof = profileRec != null ? (String) profileRec.get('Name') : null;
            // Excluded if EITHER mechanism matches (see EXCLUDED_USER_PROFILES doc
            // in Config for why name-only matching was insufficient).
            if (GSquareSalesArenaWrapperWallTV_V2.EXCLUDED_USER_NAMES.contains(nm)) continue;
            if (prof != null && GSquareSalesArenaWrapperWallTV_V2.EXCLUDED_USER_PROFILES.contains(prof)) continue;

            peopleById.put(uid, new GSquareSalesArenaWrapperWallTV_V2.PersonDTO(uid, nm));
            peopleById.get(uid).profileName = prof;
            peopleById.get(uid).zone = zone;   // this TV's zone, not the raw 'A;B' value
            peopleById.get(uid).availability = (Boolean) so.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_AVAILABILITY);
            peopleById.get(uid).initials = initialsOf(nm);
            photoRawByUser.put(uid, (String) so.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PHOTO));

            Datetime createdDt = (Datetime) so.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_CREATED_DATE);
            peopleById.get(uid).tenureEligible =
                createdDt != null && createdDt.date() <= tenureCutoff;

            nameById.put(uid, nm);
            managerIdByUser.put(uid, (Id) so.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_MANAGER_ID));
        }

        if (peopleById.isEmpty()) {
            warnings.add('No users matched the configured profiles: ' +
                         String.join(profiles, ', '));
        }
    }

    /* ---------------------------------------------------------------------
     * 2. GENERIC AGGREGATE LOADER -- driven entirely by MetricDef
     *
     *    FIX: WITH SECURITY_ENFORCED does not support aggregate functions or
     *    GROUP BY (documented Salesforce restriction). The original version of
     *    this method included it on every aggregate query, which would have
     *    thrown a runtime QueryException on 4 of the 6 metrics -- caught only
     *    by an actual sandbox deploy, which I did not have access to run.
     *    Fixed by checking field-level read access manually before the query
     *    instead of relying on the SOQL clause.
     * ------------------------------------------------------------------ */
    private void loadAggregate(GSquareSalesArenaWrapperWallTV_V2.MetricDef def, String dateLiteral, Boolean targetIsRange) {
        Schema.DescribeSObjectResult objDesc = Schema.getGlobalDescribe().get(def.objectApi).getDescribe();
        if (!objDesc.isAccessible()) {
            warnings.add('Metric "' + def.key + '" skipped: running user lacks OBJECT-level read '
                + 'access to ' + def.objectApi + '. This is a permission-set problem, not a data problem '
                + '-- do not interpret a resulting zero as "no activity".');
            return;
        }
        if (!fieldsAreReadable(def, objDesc)) {
            warnings.add('Metric "' + def.key + '" skipped: running user lacks FIELD-level '
                + 'read access on one or more fields of ' + def.objectApi + '.');
            return;
        }

        String agg = (def.aggregateType == 'SUM')
            ? 'SUM(' + def.valueField + ') aggValue'
            : 'COUNT(Id) aggValue';

        List<String> wheres = metricWheres(def, objDesc, dateLiteral);

        // NOTE: no WITH SECURITY_ENFORCED here -- unsupported alongside GROUP BY.
        // FLS is enforced above via fieldsAreReadable() instead.
        String soql =
            'SELECT ' + def.ownerField + ' ownerId, ' + agg +
            ' FROM '  + def.objectApi +
            ' WHERE ' + String.join(wheres, ' AND ') +
            ' GROUP BY ' + def.ownerField +
            ' LIMIT 50000';

        try {
            // FIX: Database.query()'s declared return type is List<SObject>.
            // AggregateResult does not extend SObject, so an inline
            // "for (AggregateResult ar : Database.query(soql))" does not compile.
            // The explicit typed variable below is the documented, compiling
            // pattern for dynamic aggregate queries.
            List<AggregateResult> results = Database.query(soql);
            for (AggregateResult ar : results) {
                Id ownerId = (Id) ar.get('ownerId');
                if (!peopleById.containsKey(ownerId)) continue;  // out of scope
                Decimal v = (Decimal) ar.get('aggValue');
                if (v == null) v = 0;
                if (def.divisor != null && def.divisor != 0) {
                    // Explicit scale + rounding mode rather than the raw "/" operator.
                    // Apex Decimal division can throw a runtime MathException on a
                    // non-terminating result (e.g. 700/60); .divide() with a fixed
                    // scale is the documented safe pattern and removes any doubt.
                    v = v.divide(def.divisor, 4, System.RoundingMode.HALF_UP);
                }
                if (targetIsRange) {
                    peopleById.get(ownerId).addMtd(def.key, v);
                } else {
                    peopleById.get(ownerId).add(def.key, v);
                }
            }
        } catch (Exception e) {
            warnings.add('Metric "' + def.key + '" failed: ' + e.getMessage());
        }
    }

    /** Manual FLS check, since SECURITY_ENFORCED cannot be used with GROUP BY. */
    /** WHERE clauses shared by the per-person aggregates and the zone race. */
    private List<String> metricWheres(GSquareSalesArenaWrapperWallTV_V2.MetricDef def,
                                      Schema.DescribeSObjectResult objDesc, String dateLiteral) {
        List<String> wheres = new List<String>();
        if (String.isNotBlank(def.dateField)) wheres.add(def.dateField + ' = ' + dateLiteral);
        if (String.isNotBlank(def.statusField) && !def.statusValues.isEmpty()) {
            wheres.add(def.statusField + ' IN (' + quoteList(def.statusValues) + ')');
        }
        // Call Count / Talk Time: exclude G-Talk inbound calls (confirmed
        // business rule -- see GSquareSalesArenaWrapperWallTV_V2.GTALK_INBOUND_EXCLUDED_METRIC_KEYS).
        // Applied unconditionally for these two metric keys, independent of
        // FTD/MTD mode -- this is a data-quality exclusion, not a date filter.
        //
        // FIX (2026-08-31): SOQL rejects "dateField = TODAY AND NOT (A AND B)
        // AND ownerField != null" with "unexpected token: 'NOT'" -- a
        // documented SOQL parser quirk where a NOT(...) fragment combined
        // with other top-level AND conditions needs its OWN extra enclosing
        // parens to parse (confirmed against real query failures in
        // production: this exact clause broke callsMade and talktime).
        // Wrapping as "(NOT (A AND B))" instead of "NOT (A AND B)" fixes it
        // without changing the boolean logic at all.
        if (GSquareSalesArenaWrapperWallTV_V2.GTALK_INBOUND_EXCLUDED_METRIC_KEYS.contains(def.key)) {
            wheres.add(
                '(NOT (' +
                GSquareSalesArenaWrapperWallTV_V2.CALL_DETAIL_FLD_SOURCE_OF_CALL + ' = \'' +
                    String.escapeSingleQuotes(GSquareSalesArenaWrapperWallTV_V2.GTALK_SOURCE_OF_CALL_VALUE) + '\'' +
                ' AND ' +
                GSquareSalesArenaWrapperWallTV_V2.CALL_DETAIL_FLD_CALL_TYPE + ' = \'' +
                    String.escapeSingleQuotes(GSquareSalesArenaWrapperWallTV_V2.GTALK_INBOUND_CALL_TYPE_VALUE) + '\'' +
                '))'
            );
        }
        wheres.addAll(buildSafeExtraFilters(def, objDesc, warnings));
        wheres.add(def.ownerField + ' != null');
        return wheres;
    }

    private Boolean fieldsAreReadable(GSquareSalesArenaWrapperWallTV_V2.MetricDef def, Schema.DescribeSObjectResult objDesc) {
        Map<String, Schema.SObjectField> fields = objDesc.fields.getMap();

        List<String> toCheck = new List<String>{ def.ownerField };
        if (String.isNotBlank(def.dateField))   toCheck.add(def.dateField);
        if (String.isNotBlank(def.statusField)) toCheck.add(def.statusField);
        if (String.isNotBlank(def.valueField))  toCheck.add(def.valueField);
        if (GSquareSalesArenaWrapperWallTV_V2.GTALK_INBOUND_EXCLUDED_METRIC_KEYS.contains(def.key)) {
            toCheck.add(GSquareSalesArenaWrapperWallTV_V2.CALL_DETAIL_FLD_SOURCE_OF_CALL);
            toCheck.add(GSquareSalesArenaWrapperWallTV_V2.CALL_DETAIL_FLD_CALL_TYPE);
        }

        for (String f : toCheck) {
            Schema.SObjectField sf = fields.get(f.toLowerCase());
            if (sf == null || !sf.getDescribe().isAccessible()) return false;
        }
        return true;
    }

    /**
     * Validates and builds SOQL for extraFilterConditions (audit finding #8).
     *
     * This is NOT superficial string escaping. Every condition must match a
     * strict "Field OP Value" shape (single condition, no AND/OR/parentheses/
     * sub-selects), the field must exist AND be readable on the target object
     * per live Schema describe, and the operator must be in a fixed allow-list.
     * A CMDT-defined condition that fails any of these checks is dropped with a
     * warning -- it can never reach the SOQL string. This is what stops
     * Extra_Filter__c from being a SOQL-injection vector for anyone with CMDT
     * edit access (a lower bar than an Apex deploy).
     */
    private static final Set<String> ALLOWED_FILTER_OPERATORS = new Set<String>{
        '>=', '<=', '!=', '=', '>', '<'
    };
    // Field name, operator, then anything else as the value (validated separately below).
    private static final Pattern FILTER_SHAPE =
        Pattern.compile('^([A-Za-z0-9_]+)\\s*(>=|<=|!=|=|>|<)\\s*(.+)$');
    // A value must be: a signed number, OR a single-quoted string with no embedded quote/backslash.
    private static final Pattern SAFE_NUMBER = Pattern.compile('^-?\\d+(\\.\\d+)?$');
    private static final Pattern SAFE_QUOTED_STRING = Pattern.compile('^\'[^\'\\\\]*\'$');
    private static final Set<String> FORBIDDEN_TOKENS = new Set<String>{
        'select', 'union', ' and ', ' or ', '(', ')', '--', ';'
    };

    /** @see buildSafeExtraFilters(MetricDef, Schema.DescribeSObjectResult, List&lt;String&gt;) */
    public static List<String> buildSafeExtraFilters(GSquareSalesArenaWrapperWallTV_V2.MetricDef def, Schema.DescribeSObjectResult objDesc, List<String> warningsOut) {
        List<String> out = new List<String>();
        if (def.extraFilterConditions == null) return out;

        Map<String, Schema.SObjectField> fields = objDesc.fields.getMap();
        for (String raw : def.extraFilterConditions) {
            String validated = validateOneFilterCondition(raw, fields, def.key, warningsOut);
            if (validated != null) out.add(validated);
        }
        return out;
    }

    public static String validateOneFilterCondition(String raw, Map<String, Schema.SObjectField> fields, String metricKey, List<String> warningsOut) {
        if (String.isBlank(raw)) return null;
        String lower = raw.toLowerCase();
        for (String bad : FORBIDDEN_TOKENS) {
            if (lower.contains(bad)) {
                warningsOut.add('Metric "' + metricKey + '": filter condition rejected '
                    + '(contains forbidden token "' + bad.trim() + '"): ' + raw);
                return null;
            }
        }

        Matcher m = FILTER_SHAPE.matcher(raw.trim());
        if (!m.matches()) {
            warningsOut.add('Metric "' + metricKey + '": filter condition does not match the '
                + 'required "Field OP Value" shape and was rejected: ' + raw);
            return null;
        }

        String fieldName = m.group(1);
        String operator   = m.group(2);
        String value       = m.group(3).trim();

        if (!ALLOWED_FILTER_OPERATORS.contains(operator)) {
            warningsOut.add('Metric "' + metricKey + '": operator "' + operator + '" is not allow-listed.');
            return null;
        }
        Schema.SObjectField sf = fields.get(fieldName.toLowerCase());
        if (sf == null || !sf.getDescribe().isAccessible()) {
            warningsOut.add('Metric "' + metricKey + '": filter field "' + fieldName
                + '" does not exist or is not readable and was rejected.');
            return null;
        }
        Boolean valueIsSafeNumber = SAFE_NUMBER.matcher(value).matches();
        Boolean valueIsSafeString = SAFE_QUOTED_STRING.matcher(value).matches();
        if (!valueIsSafeNumber && !valueIsSafeString) {
            warningsOut.add('Metric "' + metricKey + '": filter value is neither a plain number nor a '
                + 'simple quoted string and was rejected: ' + value);
            return null;
        }

        return fieldName + ' ' + operator + ' ' + value;
    }

    /* ---------------------------------------------------------------------
     * 3. BOOKINGS -- needs owner fallback, so cannot use a GROUP BY
     *    Safe: booking volume is single digits per day.
     * ------------------------------------------------------------------ */
    private void loadBookings(GSquareSalesArenaWrapperWallTV_V2.MetricDef def, String dateLiteral, Boolean targetIsRange) {
        Schema.DescribeSObjectResult objDesc = Schema.getGlobalDescribe().get(def.objectApi).getDescribe();
        if (!objDesc.isAccessible()) {
            warnings.add('Metric "' + def.key + '" skipped: running user lacks OBJECT-level read '
                + 'access to ' + def.objectApi + '.');
            return;
        }

        List<String> wheres = new List<String>();
        wheres.add(def.dateField + ' = ' + dateLiteral);
        wheres.addAll(buildSafeExtraFilters(def, objDesc, warnings));

        String soql =
            'SELECT Id, ' + def.ownerField + ', ' + def.ownerFieldAlt +
            ' FROM '  + def.objectApi +
            ' WHERE ' + String.join(wheres, ' AND ') +
            ' WITH SECURITY_ENFORCED LIMIT 10000';

        try {
            Map<String, Set<Id>> distinct = targetIsRange ? distinctMtd : distinctToday;
            if (!distinct.containsKey(def.key)) distinct.put(def.key, new Set<Id>());
            for (SObject so : Database.query(soql)) {
                // each credited person in this zone gets +1 (Presales Owner and SV User) ...
                for (Id ownerId : GSquareSalesArenaWrapperWallTV_V2.creditedOwners(so, def)) {
                    if (!peopleById.containsKey(ownerId)) continue;
                    if (targetIsRange) {
                        peopleById.get(ownerId).addMtd(def.key, 1);
                    } else {
                        peopleById.get(ownerId).add(def.key, 1);
                    }
                    // ... but the zone total counts the record once
                    distinct.get(def.key).add((Id) so.get('Id'));
                }
            }
        } catch (Exception e) {
            warnings.add('Metric "' + def.key + '" failed: ' + e.getMessage());
        }
    }

    /* ---------------------------------------------------------------------
     * 4. HIERARCHY -- walk ManagerId three levels
     * ------------------------------------------------------------------ */

    /**
     * Additional lookup passes beyond the initial loadUsers() population,
     * needed to resolve people OUTSIDE the profile scope (e.g. a TL's manager,
     * or that manager's own manager, per the confirmed "User -> TL -> Manager's
     * Manager -> Head" 3-hop business rule). This is 2, not an arbitrary
     * number: with all 3 confirmed profiles (outbound/TL/Head) already in
     * USER_PROFILES_IN_SCOPE, the only people who can still be "missing" are
     * up to 2 levels above the most senior in-scope person (their manager, and
     * that manager's manager). Verified against a real 297-person export at
     * 98% Manager/Head resolution -- if the true org hierarchy ever needs a
     * layer beyond this, increase the constant AND re-verify against real data
     * rather than guessing a bigger number.
     */
    private static final Integer HIERARCHY_EXTRA_LOOKUP_PASSES = 2;

    private void resolveHierarchy() {
        // Managers referenced by callers are usually OUTSIDE the profile filter,
        // so fetch them (and their own managers) separately.
        Set<Id> lookupIds = new Set<Id>();
        for (Id mid : managerIdByUser.values()) if (mid != null) lookupIds.add(mid);

        for (Integer level = 0; level < HIERARCHY_EXTRA_LOOKUP_PASSES && !lookupIds.isEmpty(); level++) {
            Set<Id> missing = new Set<Id>();
            for (Id i : lookupIds) if (!managerIdByUser.containsKey(i)) missing.add(i);
            if (missing.isEmpty()) break;

            for (User u : [
                SELECT Id, Name, ManagerId FROM User WHERE Id IN :missing WITH SECURITY_ENFORCED
            ]) {
                nameById.put(u.Id, u.Name);
                managerIdByUser.put(u.Id, u.ManagerId);
            }

            lookupIds = new Set<Id>();
            for (Id i : missing) {
                Id nxt = managerIdByUser.get(i);
                if (nxt != null) lookupIds.add(nxt);
            }
        }

        Integer noTl = 0, noMgr = 0;
        for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : peopleById.values()) {
            Id tl  = managerIdByUser.get(p.userId);
            Id mgr = (tl  != null) ? managerIdByUser.get(tl)  : null;
            Id hd  = (mgr != null) ? managerIdByUser.get(mgr) : null;

            if (tl != null)  { p.tlId = tl;   p.tlName = nameById.get(tl);   } else noTl++;
            if (mgr != null) { p.managerId = mgr; p.managerName = nameById.get(mgr); } else noMgr++;
            if (hd != null)  { p.headId = hd; p.headName = nameById.get(hd); }

            if (p.tlName == null)      p.tlName      = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
            if (p.managerName == null) p.managerName = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
            if (p.headName == null)    p.headName    = GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED;
        }

        // With Presales outbound/TL/Head all in USER_PROFILES_IN_SCOPE, ~98% of
        // callers should resolve Manager and Head (confirmed against a real
        // export). A rate much lower than that on go-live suggests either a
        // profile-name mismatch or a genuinely different reporting structure --
        // worth investigating rather than assuming it will fix itself.
        if (noTl  > 0) warnings.add(noTl  + ' callers have no ManagerId (no TL resolved).');
        if (noMgr > 0) warnings.add(noMgr + ' callers have no Manager/Head resolved. '
            + 'Expected ~2% at this level based on the confirmed export -- if this '
            + 'number is much higher, check USER_PROFILES_IN_SCOPE casing.');
    }

    /* ---------------------------------------------------------------------
     * 5. ASSEMBLE PAYLOAD
     * ------------------------------------------------------------------ */
    /* ---------------------------------------------------------------------
     * PHOTOS -- User.Profile_Photo_Document_Id__c holds a full ContentDocument
     * URL; resolve it to the latest version's thumbnail rendition.
     * ------------------------------------------------------------------ */
    private static final Pattern DOC_ID = Pattern.compile('069[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?');

    public static String extractDocumentId(String raw) {
        if (String.isBlank(raw)) return null;
        Matcher m = DOC_ID.matcher(raw);
        return m.find() ? m.group() : null;
    }

    public static String renditionUrl(Id versionId) {
        if (versionId == null) return null;
        return '/sfc/servlet.shepherd/version/renditionDownload?rendition=THUMB240BY180&versionId=' + versionId;
    }

    public static String initialsOf(String name) {
        if (String.isBlank(name)) return '';
        List<String> parts = name.trim().split('\\s+');
        String out = parts[0].left(1);
        if (parts.size() > 1) out += parts[parts.size() - 1].left(1);
        return out.toUpperCase();
    }

    private void loadPhotos() {
        Map<Id, String> docByUser = new Map<Id, String>();
        for (Id uid : photoRawByUser.keySet()) {
            String doc = extractDocumentId(photoRawByUser.get(uid));
            if (doc != null) docByUser.put(uid, doc.left(15));
        }
        if (docByUser.isEmpty()) return;
        Set<String> docIds = new Set<String>(docByUser.values());
        Map<String, Id> versionByDoc = new Map<String, Id>();
        try {
            for (ContentDocument d : [SELECT Id, LatestPublishedVersionId FROM ContentDocument WHERE Id IN :docIds]) {
                versionByDoc.put(String.valueOf(d.Id).left(15), d.LatestPublishedVersionId);
            }
        } catch (Exception e) {
            warnings.add('Photos skipped: ' + e.getMessage());
            return;
        }
        for (Id uid : docByUser.keySet()) {
            peopleById.get(uid).photoUrl = renditionUrl(versionByDoc.get(docByUser.get(uid)));
        }
    }

    /* ---------------------------------------------------------------------
     * ALL ZONES -- owner->group for the race (every group, on every TV), and
     * TL team sizes counted within the chosen zone only.
     * ------------------------------------------------------------------ */
    private void loadAllZoneUsers() {
        List<String> profiles = GSquareSalesArenaWrapperWallTV_V2.getUserProfilesInScope();
        String soql = 'SELECT Id, Name, ManagerId, ' + GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE +
            ' FROM User WHERE IsActive = true AND Profile.Name IN :profiles';
        for (User u : Database.query(soql)) {
            if (GSquareSalesArenaWrapperWallTV_V2.EXCLUDED_USER_NAMES.contains(u.Name)) continue;
            List<String> zs = GSquareSalesArenaWrapperWallTV_V2.zoneGroupsOf((String) u.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE));
            if (!zs.isEmpty()) zonesByUser.put(u.Id, zs);
            // team size counts only callers in the chosen zone, like everything else on the TV
            Boolean inZone = GSquareSalesArenaWrapperWallTV_V2.isAllZones(zone) || zs.contains(zone);
            if (inZone && u.ManagerId != null) {
                String k = String.valueOf(u.ManagerId);
                tlTeamSizes.put(k, (tlTeamSizes.containsKey(k) ? tlTeamSizes.get(k) : 0) + 1);
            }
        }
    }

    private List<GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry> zoneRace() {
        Map<String, Decimal> byZone = new Map<String, Decimal>();
        for (List<String> zs : zonesByUser.values()) {
            for (String z : zs) byZone.put(z, 0);
        }
        GSquareSalesArenaWrapperWallTV_V2.MetricDef def;
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
            if (d.key == 'svConducted') def = d;
        }
        if (def != null) {
            Schema.DescribeSObjectResult objDesc = Schema.getGlobalDescribe().get(def.objectApi).getDescribe();
            List<String> wheres = metricWheres(def, objDesc, GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_TODAY);
            String soql = 'SELECT ' + def.ownerField + ' ownerId, COUNT(Id) aggValue FROM ' + def.objectApi +
                ' WHERE ' + String.join(wheres, ' AND ') + ' GROUP BY ' + def.ownerField + ' LIMIT 50000';
            try {
                for (AggregateResult ar : Database.query(soql)) {
                    List<String> zs = zonesByUser.get((Id) ar.get('ownerId'));
                    if (zs == null) continue;
                    for (String z : zs) byZone.put(z, byZone.get(z) + (Decimal) ar.get('aggValue'));
                }
            } catch (Exception e) {
                warnings.add('Zone race failed: ' + e.getMessage());
            }
        }
        List<GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry> out = new List<GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry>();
        for (String z : byZone.keySet()) out.add(new GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry(z, byZone.get(z)));
        out.sort(new ZoneRaceComparator());
        return out;
    }

    private class ZoneRaceComparator implements Comparator<GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry> {
        public Integer compare(GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry a, GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry b) {
            if (a.svConducted != b.svConducted) return a.svConducted > b.svConducted ? -1 : 1;
            return a.zone.compareTo(b.zone);
        }
    }

    /* ---------------------------------------------------------------------
     * BASELINE -- today's IST weekday curves and last-month-to-date, written
     * nightly by GSquareArenaBaselineJob.
     * ------------------------------------------------------------------ */
    private GSquareSalesArenaWrapperWallTV_V2.BaselineDTO loadBaseline() {
        GSquareSalesArenaWrapperWallTV_V2.BaselineDTO b = new GSquareSalesArenaWrapperWallTV_V2.BaselineDTO();
        Date today = GSquareArenaBaselineJob.istToday();
        Integer wd = GSquareArenaBaselineJob.weekdayOf(today);
        Integer dom = today.day();
        String zoneKey = GSquareArenaBaselineJob.zoneScope(zone);
        Map<String, String> tlByScope = new Map<String, String>();
        for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : peopleById.values()) {
            if (p.tlId != null) tlByScope.put(GSquareArenaBaselineJob.tlScope(zone, p.tlId), String.valueOf(p.tlId));
        }
        Set<String> scopes = new Set<String>(tlByScope.keySet());
        scopes.add(zoneKey);
        for (GSquare_Arena_Baseline__c r : [
            SELECT Scope_Key__c, Metric_Key__c, Kind__c, Hour__c, Value__c
            FROM GSquare_Arena_Baseline__c
            WHERE Scope_Key__c IN :scopes
              AND ((Kind__c = :GSquareArenaBaselineJob.KIND_HOURLY AND Weekday__c = :wd)
                OR (Kind__c = :GSquareArenaBaselineJob.KIND_MTD AND Day_Of_Month__c = :dom))
        ]) {
            if (r.Kind__c == GSquareArenaBaselineJob.KIND_MTD) {
                if (r.Scope_Key__c == zoneKey) b.lastMonthToDate.put(r.Metric_Key__c, r.Value__c);
                continue;
            }
            Integer h = r.Hour__c == null ? null : r.Hour__c.intValue();
            if (h == null || h < 0 || h > 23) continue;
            if (r.Scope_Key__c == zoneKey) {
                if (!b.hourly.containsKey(r.Metric_Key__c)) b.hourly.put(r.Metric_Key__c, zeros24());
                b.hourly.get(r.Metric_Key__c)[h] = r.Value__c;
            } else if (r.Metric_Key__c == 'svConducted' && tlByScope.containsKey(r.Scope_Key__c)) {
                String tl = tlByScope.get(r.Scope_Key__c);
                if (!b.tlHourly.containsKey(tl)) b.tlHourly.put(tl, zeros24());
                b.tlHourly.get(tl)[h] = r.Value__c;
            }
        }
        return b;
    }

    private static List<Decimal> zeros24() {
        List<Decimal> z = new List<Decimal>();
        for (Integer h = 0; h < 24; h++) z.add(0);
        return z;
    }

    private GSquareSalesArenaWrapperWallTV_V2.DashboardDTO assemble() {
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = new GSquareSalesArenaWrapperWallTV_V2.DashboardDTO();

        dto.metricDefs = new List<GSquareSalesArenaWrapperWallTV_V2.MetricInfo>();
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
            dto.metricDefs.add(new GSquareSalesArenaWrapperWallTV_V2.MetricInfo(d));
        }

        dto.people = peopleById.values();

        // Zero-fill so the LWC never handles undefined
        for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : dto.people) {
            for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
                if (d.isRate == true) continue;
                if (!p.metrics.containsKey(d.key)) p.metrics.put(d.key, 0);
            }
        }

        // Floor totals
        dto.totals = new Map<String, Decimal>();
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
            if (d.isRate == true) continue;
            Decimal sum = 0;
            for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : dto.people) sum += p.metrics.get(d.key);
            // shared credit (booking): count records, not people's credits
            if (distinctToday.containsKey(d.key)) sum = distinctToday.get(d.key).size();
            dto.totals.put(d.key, sum);
        }
        // Derived rates from the same config. Each rate is isolated in its own
        // try/catch (audit finding #5): a malformed numerator/denominator key
        // -- plausible via a CMDT typo -- must skip only that one rate metric
        // with a warning, never take down the whole dashboard the way an
        // unguarded null-dereference here previously would have.
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
            if (d.isRate != true) continue;
            try {
                if (String.isBlank(d.numeratorKey) || String.isBlank(d.denominatorKey)) {
                    warnings.add('Rate metric "' + d.key + '" is missing numeratorKey/denominatorKey; skipped.');
                    dto.totals.put(d.key, 0);
                    continue;
                }
                Decimal num = dto.totals.get(d.numeratorKey);
                Decimal den = dto.totals.get(d.denominatorKey);
                if (num == null) {
                    warnings.add('Rate metric "' + d.key + '" numerator key "' + d.numeratorKey
                        + '" does not match any known metric; skipped.');
                    dto.totals.put(d.key, 0);
                    continue;
                }
                if (den == null || den <= 0) {
                    // Zero/missing denominator is an expected, non-error state (e.g. no
                    // scheduled visits yet today) -- not warning-worthy, just zero.
                    dto.totals.put(d.key, 0);
                    continue;
                }
                dto.totals.put(d.key, (num.divide(den, 6, System.RoundingMode.HALF_UP) * 100).setScale(1));
            } catch (Exception e) {
                warnings.add('Rate metric "' + d.key + '" failed to compute: ' + e.getMessage());
                dto.totals.put(d.key, 0);
            }
        }

        // Team Spotlight rotation order: keyed by real TL Id (not display name --
        // see TeamRosterEntry doc for why), largest team first. The previous
        // version keyed on tlName, which would silently merge two same-named
        // TLs into one rotation slot and, worse, cause the LWC's per-team
        // filter (matching on name) to combine both real teams' individual
        // rosters into a single Team Spotlight view.
        Map<Id, Integer> teamSizeById = new Map<Id, Integer>();
        for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : dto.people) {
            if (p.tlName == GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED || p.tlId == null) continue;
            teamSizeById.put(p.tlId, (teamSizeById.containsKey(p.tlId) ? teamSizeById.get(p.tlId) : 0) + 1);
        }
        List<GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry> roster = new List<GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry>();
        for (Id tlId : teamSizeById.keySet()) {
            GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry entry = new GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry();
            entry.tlId = tlId;
            entry.tlName = nameById.get(tlId);
            entry.teamSize = teamSizeById.get(tlId);
            roster.add(entry);
        }
        // Actually sort by size descending -- the comment always said "largest
        // teams first" but the previous code only called tls.sort() on a plain
        // String list, which sorts alphabetically. That mismatch is fixed here.
        roster.sort(new TeamRosterSizeComparator());
        dto.teamRoster = roster;

        dto.lastUpdated = System.now();
        dto.zone           = zone;
        dto.zoneConfigured = zone != null;
        dto.mtdTotals = new Map<String, Decimal>();
        for (String k : GSquareSalesArenaWrapperWallTV_V2.HERO_METRIC_KEYS) {
            Decimal mtdSum = 0;
            for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : dto.people) {
                if (!p.mtdMetrics.containsKey(k)) p.mtdMetrics.put(k, 0);
                mtdSum += p.mtdMetrics.get(k);
            }
            if (distinctMtd.containsKey(k)) mtdSum = distinctMtd.get(k).size();
            dto.mtdTotals.put(k, mtdSum);
        }
        dto.zoneRace    = zone == null ? new List<GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry>() : zoneRace();
        dto.baseline    = zone == null ? new GSquareSalesArenaWrapperWallTV_V2.BaselineDTO() : loadBaseline();
        dto.tlTeamSizes = tlTeamSizes;
        dto.warnings    = warnings;

        dto.settings = new Map<String, Object>{
            'tierSeconds'            => GSquareSalesArenaWrapperWallTV_V2.TIER_SECONDS,
            'modeFlipSeconds'        => GSquareSalesArenaWrapperWallTV_V2.MODE_FLIP_SECONDS,
            'boardRowLimit'          => GSquareSalesArenaWrapperWallTV_V2.BOARD_ROW_LIMIT,
            'alertHoldSeconds'       => GSquareSalesArenaWrapperWallTV_V2.ALERT_HOLD_SECONDS,
            'overlayHoldSeconds'     => GSquareSalesArenaWrapperWallTV_V2.OVERLAY_HOLD_SECONDS,
            'overlayManagerMinutes'  => GSquareSalesArenaWrapperWallTV_V2.OVERLAY_MANAGER_EVERY_MINUTES,
            'overlayHeadMinutes'     => GSquareSalesArenaWrapperWallTV_V2.OVERLAY_HEAD_EVERY_MINUTES,
            'refreshSeconds'         => GSquareSalesArenaWrapperWallTV_V2.REFRESH_INTERVAL_SECONDS,
            'watchlistMinWeak'       => GSquareSalesArenaWrapperWallTV_V2.WATCHLIST_MIN_WEAK_METRICS,
            'watchlistMaxEntries'    => GSquareSalesArenaWrapperWallTV_V2.WATCHLIST_MAX_ENTRIES,
            'alertCriticalZeroCount' => GSquareSalesArenaWrapperWallTV_V2.ALERT_CRITICAL_ZERO_COUNT,
            'rateGoodThreshold'      => GSquareSalesArenaWrapperWallTV_V2.RATE_GOOD_THRESHOLD,
            'rateBadThreshold'       => GSquareSalesArenaWrapperWallTV_V2.RATE_BAD_THRESHOLD,
            'alertPopupProfile'      => GSquareSalesArenaWrapperWallTV_V2.ALERT_POPUP_PROFILE
        };
        return dto;
    }

    /** Largest team first; ties broken by name for a stable, deterministic order. */
    private class TeamRosterSizeComparator implements Comparator<GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry> {
        public Integer compare(GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry a, GSquareSalesArenaWrapperWallTV_V2.TeamRosterEntry b) {
            if (b.teamSize != a.teamSize) return b.teamSize - a.teamSize;
            return a.tlName.compareTo(b.tlName);
        }
    }

    /* ---------------------------------------------------------------------
     * Helper
     * ------------------------------------------------------------------ */
    public static String quoteList(List<String> vals) {
        List<String> out = new List<String>();
        for (String v : vals) out.add('\'' + String.escapeSingleQuotes(v) + '\'');
        return String.join(out, ', ');
    }

}