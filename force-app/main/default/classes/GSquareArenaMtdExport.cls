/**
 * TEMPORARY validation aid behind the TV's "Export MTD" button: the
 * month-to-date records behind the Allocation, SV Conducted and Booking
 * tiles, for manual checking (booking reference, project, flat).
 *
 * Uses the same users, zone group and metric definitions as
 * GSquareSalesArenaServiceWallTV_V2, so each sheet's row count should equal
 * the MTD number on the TV. Remove together with the button once validated.
 */
public without sharing class GSquareArenaMtdExport {
  public class Sheet {
    @AuraEnabled
    public String name;
    @AuraEnabled
    public List<List<String>> rows = new List<List<String>>();

    Sheet(String name, List<String> header) {
      this.name = name;
      rows.add(header);
    }
    void add(List<String> row) {
      rows.add(row);
    }
    Integer count() {
      return rows.size() - 1;
    }
  }

  public class Result {
    @AuraEnabled
    public String zone;
    @AuraEnabled
    public List<Sheet> sheets = new List<Sheet>();
  }

  private static final String TZ = 'Asia/Kolkata';
  private static final Integer MAX_ROWS = 10000;

  private String zone;
  private Map<Id, User> users = new Map<Id, User>();

  public static Result build(String zoneParam) {
    return new GSquareArenaMtdExport().run(zoneParam);
  }

  private Result run(String zoneParam) {
    Result res = new Result();
    zone = GSquareSalesArenaWrapperWallTV_V2.resolveZoneGroup(zoneParam);
    res.zone = zone;
    if (zone == null)
      return res;
    loadUsers();

    Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef> defs = new Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef>();
    for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics())
      defs.put(d.key, d);

    Sheet alloc = allocation(defs.get('allocation'));
    Sheet conducted = svConducted(defs.get('svConducted'));
    Sheet booked = bookings(defs.get('booking'));

    Sheet summary = new Sheet(
      'Summary',
      new List<String>{ 'Metric', 'MTD count', 'Zone', 'Generated (IST)' }
    );
    String generated = Datetime.now().format('dd-MM-yyyy HH:mm', TZ);
    summary.add(new List<String>{ 'Allocation', String.valueOf(alloc.count()), zone, generated });
    summary.add(new List<String>{ 'SV Conducted', String.valueOf(conducted.count()), zone, generated });
    summary.add(new List<String>{ 'Booking', String.valueOf(booked.count()), zone, generated });

    res.sheets.add(summary);
    res.sheets.add(alloc);
    res.sheets.add(conducted);
    res.sheets.add(booked);
    return res;
  }

  /* ---------------------------------------------------------------- users */

  /** Same population as the TV: in-scope profiles, chosen zone group, minus excluded users. */
  private void loadUsers() {
    String zoneFld = GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE;
    List<String> profiles = GSquareSalesArenaWrapperWallTV_V2.getUserProfilesInScope();
    String soql =
      'SELECT Id, Name, Manager.Name, Profile.Name, ' + zoneFld +
      ' FROM User WHERE IsActive = true AND Profile.Name IN :profiles';
    if (!GSquareSalesArenaWrapperWallTV_V2.isAllZones(zone))
      soql += ' AND ' + zoneFld + ' INCLUDES (' + quoted(GSquareSalesArenaWrapperWallTV_V2.zonesInGroup(zone)) + ')';
    for (User u : Database.query(soql)) {
      if (GSquareSalesArenaWrapperWallTV_V2.EXCLUDED_USER_NAMES.contains(u.Name))
        continue;
      if (u.Profile != null && GSquareSalesArenaWrapperWallTV_V2.EXCLUDED_USER_PROFILES.contains(u.Profile.Name))
        continue;
      users.put(u.Id, u);
    }
  }

  /* --------------------------------------------------------------- sheets */

  private Sheet allocation(GSquareSalesArenaWrapperWallTV_V2.MetricDef d) {
    Sheet s = new Sheet(
      'Allocation',
      new List<String>{ 'Lead Name', 'Lead Id', 'Qualified On', 'Allocated Project', 'Project', 'Qualified By (caller)', 'TL', 'Zone' }
    );
    Set<Id> ownerIds = users.keySet();
    String soql =
      'SELECT Id, Name, ' + d.dateField + ', ' + d.ownerField + ', Allocated_Project__c, Project__c' +
      ' FROM ' + d.objectApi +
      ' WHERE ' + baseWhere(d) + ' AND ' + d.ownerField + ' IN :ownerIds' +
      ' ORDER BY ' + d.dateField + ' LIMIT ' + MAX_ROWS;
    try {
      for (SObject r : Database.query(soql)) {
        User u = users.get((Id) r.get(d.ownerField));
        s.add(new List<String>{
          text(r, 'Name'), String.valueOf(r.Id), text(r, d.dateField),
          text(r, 'Allocated_Project__c'), text(r, 'Project__c'),
          u.Name, tlOf(u), zoneOf(u)
        });
      }
    } catch (Exception e) {
      s.add(new List<String>{ 'EXPORT FAILED: ' + e.getMessage() });
    }
    return s;
  }

  private Sheet svConducted(GSquareSalesArenaWrapperWallTV_V2.MetricDef d) {
    Sheet s = new Sheet(
      'SV Conducted',
      new List<String>{ 'Site Visit Number', 'Conducted On', 'Status', 'Project', 'Visit Type', 'Lead Name', 'Scheduled By (credited caller)', 'Conducted By', 'TL', 'Zone' }
    );
    Set<Id> ownerIds = users.keySet();
    String soql =
      'SELECT Id, Name, ' + d.dateField + ', ' + d.ownerField + ', Status__c, Project__c, Visit_Type__c, Lead__r.Name, Conducted_By__r.Name' +
      ' FROM ' + d.objectApi +
      ' WHERE ' + baseWhere(d) + ' AND ' + d.ownerField + ' IN :ownerIds' +
      ' ORDER BY ' + d.dateField + ' LIMIT ' + MAX_ROWS;
    try {
      for (SObject r : Database.query(soql)) {
        User u = users.get((Id) r.get(d.ownerField));
        s.add(new List<String>{
          text(r, 'Name'), text(r, d.dateField), text(r, 'Status__c'),
          text(r, 'Project__c'), text(r, 'Visit_Type__c'), text(r, 'Lead__r.Name'),
          u.Name, text(r, 'Conducted_By__r.Name'), tlOf(u), zoneOf(u)
        });
      }
    } catch (Exception e) {
      s.add(new List<String>{ 'EXPORT FAILED: ' + e.getMessage() });
    }
    return s;
  }

  /** Credited like the TV: Presales Owner if set, else SV User (never both). */
  private Sheet bookings(GSquareSalesArenaWrapperWallTV_V2.MetricDef d) {
    Sheet s = new Sheet(
      'Booking',
      new List<String>{ 'Opportunity Name', 'Booking Reference Number', 'Allotment / Booking Reference No', 'Project', 'Unit', 'Flat No', 'Plot No', 'Tower', 'Booking Date', 'Stage', 'Total Receipts', 'Credited To', 'Credited Via', 'TL', 'Zone' }
    );
    String soql =
      'SELECT Id, Name, Booking_Reference_Number__c, Allotment_Booking_Reference_Number__c, Project__c,' +
      ' Apartment__r.Name, Apartment__r.Flat_No__c, Apartment__r.Unit_Number__c, Apartment__r.Tower__c,' +
      ' StageName, ' + d.dateField + ', Total_Receipts__c, ' + d.ownerField + ', ' + d.ownerFieldAlt +
      ' FROM ' + d.objectApi +
      ' WHERE ' + baseWhere(d) +
      ' ORDER BY ' + d.dateField + ' LIMIT ' + MAX_ROWS;
    try {
      for (SObject r : Database.query(soql)) {
        Id owner = (Id) r.get(d.ownerField);
        String via = 'Presales Owner';
        if (owner == null) {
          owner = (Id) r.get(d.ownerFieldAlt);
          via = 'SV User';
        }
        User u = owner == null ? null : users.get(owner);
        if (u == null)
          continue; // credited to someone outside this zone, as on the TV
        s.add(new List<String>{
          text(r, 'Name'), text(r, 'Booking_Reference_Number__c'), text(r, 'Allotment_Booking_Reference_Number__c'),
          text(r, 'Project__c'), text(r, 'Apartment__r.Name'), text(r, 'Apartment__r.Flat_No__c'),
          text(r, 'Apartment__r.Unit_Number__c'), text(r, 'Apartment__r.Tower__c'),
          text(r, d.dateField), text(r, 'StageName'), text(r, 'Total_Receipts__c'),
          u.Name, via, tlOf(u), zoneOf(u)
        });
      }
    } catch (Exception e) {
      s.add(new List<String>{ 'EXPORT FAILED: ' + e.getMessage() });
    }
    return s;
  }

  /* -------------------------------------------------------------- helpers */

  /** Month to date plus the metric's own status and extra filters, as on the TV. */
  @TestVisible
  private static String baseWhere(GSquareSalesArenaWrapperWallTV_V2.MetricDef d) {
    List<String> w = new List<String>{
      d.dateField + ' = ' + GSquareSalesArenaWrapperWallTV_V2.DATE_RANGE_THIS_MONTH
    };
    if (String.isNotBlank(d.statusField) && d.statusValues != null && !d.statusValues.isEmpty())
      w.add(d.statusField + ' IN (' + quoted(d.statusValues) + ')');
    // the TV's own validator, so extra filters are applied exactly as on the tiles
    w.addAll(
      GSquareSalesArenaServiceWallTV_V2.buildSafeExtraFilters(
        d,
        Schema.getGlobalDescribe().get(d.objectApi).getDescribe(),
        new List<String>()
      )
    );
    return String.join(w, ' AND ');
  }

  private static String quoted(List<String> values) {
    List<String> out = new List<String>();
    for (String v : values)
      out.add('\'' + String.escapeSingleQuotes(v) + '\'');
    return String.join(out, ',');
  }

  /** A field or dotted relationship path as text; dates in IST. */
  @TestVisible
  private static String text(SObject rec, String path) {
    SObject cur = rec;
    List<String> parts = path.split('\\.');
    for (Integer i = 0; i < parts.size() - 1; i++) {
      cur = cur.getSObject(parts[i]);
      if (cur == null)
        return '';
    }
    String field = parts[parts.size() - 1];
    Object v = cur.get(field);
    if (v == null)
      return '';
    // the field's declared type: a Date value also passes "instanceof Datetime"
    Schema.DisplayType t = cur.getSObjectType()
      .getDescribe()
      .fields.getMap()
      .get(field)
      .getDescribe()
      .getType();
    if (t == Schema.DisplayType.DATETIME)
      return ((Datetime) v).format('dd-MM-yyyy HH:mm', TZ);
    if (t == Schema.DisplayType.DATE) {
      Date d = (Date) v;
      return String.valueOf(d.day()).leftPad(2, '0') + '-' + String.valueOf(d.month()).leftPad(2, '0') + '-' + d.year();
    }
    return String.valueOf(v);
  }

  private static String tlOf(User u) {
    return u.Manager == null ? '' : u.Manager.Name;
  }

  private static String zoneOf(User u) {
    return String.join(
      GSquareSalesArenaWrapperWallTV_V2.zoneGroupsOf((String) u.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE)),
      ', '
    );
  }
}
