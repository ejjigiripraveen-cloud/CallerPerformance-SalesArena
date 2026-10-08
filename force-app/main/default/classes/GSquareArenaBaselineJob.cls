/**
 * Nightly "typical day" baselines for the Sales Arena zone TV wall.
 *
 * HOURLY rows: for each scope (zone, and TL within zone), metric, weekday and
 * hour, the average cumulative count by the END of that IST hour over the
 * last 4 same weekdays. MTD rows: last month's to-date total for a given day
 * of the month (capped at last month's length).
 *
 * All windows are computed in IST explicitly, so the result never depends on
 * the timezone of whoever scheduled the job. Date-only source fields have no
 * time of day; their day total is ramped evenly across office hours.
 */
public without sharing class GSquareArenaBaselineJob implements Schedulable {
  public static final String JOB_NAME = 'GSquare Arena Baseline';
  public static final String CRON = '0 30 1 * * ?';
  public static final Set<String> BASELINE_METRICS = new Set<String>{
    'allocation',
    'svScheduled',
    'svConducted',
    'booking'
  };
  public static final Integer IST_OFFSET_MINUTES = 330;
  public static final Integer WEEKS = 4;
  public static final Integer RAMP_START_HOUR = 9;
  public static final Integer RAMP_END_HOUR = 20;
  public static final String KIND_HOURLY = 'HOURLY';
  public static final String KIND_MTD = 'MTD';

  public void execute(SchedulableContext sc) {
    runAsync(istToday());
  }

  public static String scheduleNightly() {
    return System.schedule(JOB_NAME, CRON, new GSquareArenaBaselineJob());
  }

  /* ------------------------------------------------------------ IST time */

  public static Date istToday() {
    return Datetime.now().addMinutes(IST_OFFSET_MINUTES).dateGmt();
  }

  public static Datetime istToGmt(Date d, Integer hour, Integer minute) {
    return Datetime.newInstanceGmt(d, Time.newInstance(hour, minute, 0, 0))
      .addMinutes(-IST_OFFSET_MINUTES);
  }

  public static Integer istHour(Datetime gmt) {
    return gmt.addMinutes(IST_OFFSET_MINUTES).hourGmt();
  }

  /** 1 = Monday ... 7 = Sunday. */
  public static Integer weekdayOf(Date d) {
    return Integer.valueOf(
      Datetime.newInstanceGmt(d, Time.newInstance(12, 0, 0, 0)).formatGmt('u')
    );
  }

  /* ---------------------------------------------------------------- keys */

  public static String hourlyKey(
    String scope,
    String metricKey,
    Integer weekday,
    Integer hour
  ) {
    return scope +
      '|' +
      metricKey +
      '|' +
      KIND_HOURLY +
      '|' +
      weekday +
      '|' +
      hour;
  }

  public static String mtdKey(
    String scope,
    String metricKey,
    Integer dayOfMonth
  ) {
    return scope + '|' + metricKey + '|' + KIND_MTD + '|' + dayOfMonth;
  }

  public static String zoneScope(String zone) {
    return 'ZONE:' + zone;
  }

  public static String tlScope(String zone, Id tlId) {
    return 'TL:' + zone + ':' + tlId;
  }

  /* ----------------------------------------------------------------- run */

  /** Ordered work units: [metricKey, KIND_HOURLY | KIND_MTD]. */
  public static List<List<String>> steps() {
    List<List<String>> out = new List<List<String>>();
    for (
      GSquareSalesArenaWrapperWallTV_V2.MetricDef def : GSquareSalesArenaWrapperWallTV_V2.getMetrics()
    ) {
      if (!BASELINE_METRICS.contains(def.key))
        continue;
      out.add(new List<String>{ def.key, KIND_HOURLY });
      out.add(new List<String>{ def.key, KIND_MTD });
    }
    return out;
  }

  /** Production path: one Queueable per step, so each gets its own governor limits. */
  public static Id runAsync(Date target) {
    return System.enqueueJob(new Step(target, 0));
  }

  public class Step implements Queueable {
    private Date target;
    private Integer index;
    public Step(Date target, Integer index) {
      this.target = target;
      this.index = index;
    }
    public void execute(QueueableContext qc) {
      List<List<String>> all = steps();
      if (index >= all.size())
        return;
      computeStep(target, all[index][0], all[index][1]);
      // chained Queueables cannot be enqueued from a test
      if (index + 1 < all.size() && !Test.isRunningTest()) {
        System.enqueueJob(new Step(target, index + 1));
      }
    }
  }

  /** Synchronous run of every step (tests, small orgs). */
  public static void computeFor(Date target) {
    for (List<String> st : steps())
      computeStep(target, st[0], st[1]);
  }

  public static void computeStep(Date target, String metricKey, String kind) {
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def;
    for (
      GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()
    ) {
      if (d.key == metricKey)
        def = d;
    }
    if (def == null)
      return;
    Map<Id, List<String>> scopesByUser = loadScopes();
    Set<String> allScopes = new Set<String>();
    for (List<String> scopes : scopesByUser.values())
      allScopes.addAll(scopes);
    Boolean isDateTime = isDateTimeField(def);
    Map<String, GSquare_Arena_Baseline__c> rows = new Map<String, GSquare_Arena_Baseline__c>();

    if (kind == KIND_HOURLY) {
      Integer weekday = weekdayOf(target);
      // every scope gets rows, so a quiet zone reads "typical 0", not stale data
      Map<String, List<Decimal>> sums = new Map<String, List<Decimal>>();
      for (String scope : allScopes)
        sums.put(scope, zeros());
      for (Integer w = 1; w <= WEEKS; w++) {
        Map<String, List<Decimal>> day = dayCurve(
          def,
          target.addDays(-7 * w),
          isDateTime,
          scopesByUser
        );
        for (String scope : day.keySet()) {
          if (!sums.containsKey(scope))
            sums.put(scope, zeros());
          for (Integer h = 0; h < 24; h++)
            sums.get(scope)[h] += day.get(scope)[h];
        }
      }
      for (String scope : sums.keySet()) {
        for (Integer h = 0; h < 24; h++) {
          String key = hourlyKey(scope, def.key, weekday, h);
          rows.put(
            key,
            new GSquare_Arena_Baseline__c(
              Unique_Key__c = key,
              Scope_Key__c = scope,
              Metric_Key__c = def.key,
              Kind__c = KIND_HOURLY,
              Weekday__c = weekday,
              Hour__c = h,
              Value__c = (sums.get(scope)[h] / WEEKS).setScale(2)
            )
          );
        }
      }
    } else {
      Map<String, Decimal> mtd = lastMonthToDate(
        def,
        target,
        isDateTime,
        scopesByUser
      );
      for (String scope : allScopes)
        if (!mtd.containsKey(scope))
          mtd.put(scope, 0);
      for (String scope : mtd.keySet()) {
        String key = mtdKey(scope, def.key, target.day());
        rows.put(
          key,
          new GSquare_Arena_Baseline__c(
            Unique_Key__c = key,
            Scope_Key__c = scope,
            Metric_Key__c = def.key,
            Kind__c = KIND_MTD,
            Day_Of_Month__c = target.day(),
            Value__c = mtd.get(scope)
          )
        );
      }
    }
    upsert rows.values() Unique_Key__c;
  }

  /* ------------------------------------------------------------- scopes */

  private static Map<Id, List<String>> loadScopes() {
    Map<Id, List<String>> out = new Map<Id, List<String>>();
    List<String> profiles = GSquareSalesArenaWrapperWallTV_V2.USER_PROFILES_IN_SCOPE;
    String soql =
      'SELECT Id, ManagerId, ' +
      GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE +
      ' FROM User WHERE IsActive = true AND Profile.Name IN :profiles AND ' +
      GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE +
      ' != null';
    // Tests can always see real users; keep their baselines to test users
    // so a test run stays under the DML row limit.
    if (Test.isRunningTest())
      soql += ' AND Username LIKE \'%@arena.test\'';
    for (User u : Database.query(soql)) {
      // Multi-select zone: a user counts in every seating group they belong to.
      List<String> scopes = new List<String>();
      for (String zone : GSquareSalesArenaWrapperWallTV_V2.zoneGroupsOf(
          (String) u.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE)
        )) {
        scopes.add(zoneScope(zone));
        if (u.ManagerId != null)
          scopes.add(tlScope(zone, u.ManagerId));
      }
      out.put(u.Id, scopes);
    }
    return out;
  }

  /* ------------------------------------------------------------ queries */

  private static Boolean isDateTimeField(
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def
  ) {
    Schema.SObjectField f = Schema.getGlobalDescribe()
      .get(def.objectApi)
      .getDescribe()
      .fields.getMap()
      .get(def.dateField.toLowerCase());
    return f != null &&
      f.getDescribe().getType() == Schema.DisplayType.DATETIME;
  }

  private static List<String> filters(GSquareSalesArenaWrapperWallTV_V2.MetricDef def) {
    List<String> wheres = new List<String>();
    if (
      String.isNotBlank(def.statusField) &&
      def.statusValues != null &&
      !def.statusValues.isEmpty()
    ) {
      wheres.add(
        def.statusField +
          ' IN (' +
          GSquareSalesArenaServiceWallTV_V2.quoteList(def.statusValues) +
          ')'
      );
    }
    Schema.DescribeSObjectResult objDesc = Schema.getGlobalDescribe()
      .get(def.objectApi)
      .getDescribe();
    wheres.addAll(
      GSquareSalesArenaServiceWallTV_V2.buildSafeExtraFilters(
        def,
        objDesc,
        new List<String>()
      )
    );
    return wheres;
  }

  private static String ownerSelect(GSquareSalesArenaWrapperWallTV_V2.MetricDef def) {
    return def.ownerField +
      (String.isNotBlank(def.ownerFieldAlt) ? ', ' + def.ownerFieldAlt : '');
  }

  private static Id ownerOf(
    SObject so,
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def
  ) {
    Id owner = (Id) so.get(def.ownerField);
    if (owner == null && String.isNotBlank(def.ownerFieldAlt))
      owner = (Id) so.get(def.ownerFieldAlt);
    return owner;
  }

  /** Rows for one window. Bind variables are referenced by name in the SOQL. */
  private static List<SObject> fetch(
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def,
    Boolean isDateTime,
    Date fromDate,
    Date toDate
  ) {
    Datetime fromGmt = istToGmt(fromDate, 0, 0);
    Datetime toGmt = istToGmt(toDate.addDays(1), 0, 0);
    List<String> wheres = filters(def);
    if (isDateTime) {
      wheres.add(def.dateField + ' >= :fromGmt');
      wheres.add(def.dateField + ' < :toGmt');
    } else {
      wheres.add(def.dateField + ' >= :fromDate');
      wheres.add(def.dateField + ' <= :toDate');
    }
    String soql =
      'SELECT ' +
      ownerSelect(def) +
      ', ' +
      def.dateField +
      ' FROM ' +
      def.objectApi +
      ' WHERE ' +
      String.join(wheres, ' AND ') +
      ' LIMIT 45000';
    return Database.query(soql);
  }

  private static Map<String, List<Decimal>> dayCurve(
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def,
    Date d,
    Boolean isDateTime,
    Map<Id, List<String>> scopesByUser
  ) {
    Map<String, List<Decimal>> perHour = new Map<String, List<Decimal>>();
    for (SObject so : fetch(def, isDateTime, d, d)) {
      List<String> scopes = scopesByUser.get(ownerOf(so, def));
      if (scopes == null)
        continue;
      for (String scope : scopes) {
        if (!perHour.containsKey(scope))
          perHour.put(scope, zeros());
        if (isDateTime) {
          perHour.get(scope)[istHour((Datetime) so.get(def.dateField))] += 1;
        } else {
          perHour.get(scope)[23] += 1; // day total; ramped below
        }
      }
    }
    Map<String, List<Decimal>> cumulative = new Map<String, List<Decimal>>();
    for (String scope : perHour.keySet()) {
      List<Decimal> src = perHour.get(scope);
      List<Decimal> cum = zeros();
      if (isDateTime) {
        Decimal running = 0;
        for (Integer h = 0; h < 24; h++) {
          running += src[h];
          cum[h] = running;
        }
      } else {
        Decimal total = src[23];
        Decimal span = RAMP_END_HOUR - RAMP_START_HOUR;
        for (Integer h = 0; h < 24; h++) {
          Decimal share = Math.min(
            1.0,
            Math.max(0.0, (h + 1 - RAMP_START_HOUR) / span)
          );
          cum[h] = total * share;
        }
      }
      cumulative.put(scope, cum);
    }
    return cumulative;
  }

  private static Map<String, Decimal> lastMonthToDate(
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def,
    Date target,
    Boolean isDateTime,
    Map<Id, List<String>> scopesByUser
  ) {
    Date lastStart = target.toStartOfMonth().addMonths(-1);
    Integer cap = Math.min(
      target.day(),
      Date.daysInMonth(lastStart.year(), lastStart.month())
    );
    Date lastEnd = lastStart.addDays(cap - 1);
    Map<String, Decimal> out = new Map<String, Decimal>();
    for (SObject so : fetch(def, isDateTime, lastStart, lastEnd)) {
      List<String> scopes = scopesByUser.get(ownerOf(so, def));
      if (scopes == null)
        continue;
      for (String scope : scopes) {
        out.put(scope, (out.containsKey(scope) ? out.get(scope) : 0) + 1);
      }
    }
    return out;
  }

  private static List<Decimal> zeros() {
    List<Decimal> z = new List<Decimal>();
    for (Integer h = 0; h < 24; h++)
      z.add(0);
    return z;
  }
}
