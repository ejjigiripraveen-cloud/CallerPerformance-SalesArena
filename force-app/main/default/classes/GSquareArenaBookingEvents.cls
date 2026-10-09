/**
 * Publishes GSquare_Arena_Booking__e when an Opportunity becomes a booking
 * (same criteria as the Sales Arena "booking" metric, booked today in IST),
 * so every zone TV can celebrate it within seconds.
 */
public without sharing class GSquareArenaBookingEvents {
  public static final String FLD_RECEIPTS = 'Total_Receipts__c';
  /** Opportunity field path holding the project name, e.g. 'Project__r.Name'. Null = takeover hides it. */
  public static String PROJECT_FIELD = null;

  @TestVisible
  private static List<GSquare_Arena_Booking__e> published = new List<GSquare_Arena_Booking__e>();

  private static GSquareSalesArenaWrapperWallTV_V2.MetricDef bookingDef() {
    for (
      GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()
    ) {
      if (d.key == 'booking')
        return d;
    }
    return null;
  }

  private static Date istDate(Object v) {
    if (v instanceof Datetime)
      return ((Datetime) v)
        .addMinutes(GSquareArenaBaselineJob.IST_OFFSET_MINUTES)
        .dateGmt();
    return (Date) v;
  }

  public static Boolean qualifies(
    Opportunity o,
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def
  ) {
    if (o == null)
      return false;
    Decimal receipts = (Decimal) o.get(FLD_RECEIPTS);
    return receipts != null &&
      receipts > GSquareSalesArenaWrapperWallTV_V2.BOOKING_MIN_RECEIPTS &&
      o.StageName != GSquareSalesArenaWrapperWallTV_V2.BOOKING_EXCLUDED_STAGE &&
      GSquareSalesArenaWrapperWallTV_V2.anyFieldSet(o, def) &&
      istDate(o.get(def.dateField)) == GSquareArenaBaselineJob.istToday();
  }

  public static void publishNewBookings(
    List<Opportunity> newList,
    Map<Id, Opportunity> oldMap
  ) {
    GSquareSalesArenaWrapperWallTV_V2.MetricDef def = bookingDef();
    if (def == null)
      return;

    // every credited person (Presales Owner and SV User): each one's zone TV
    // celebrates; a TV showing both de-duplicates by Opportunity Id
    Map<Id, List<Id>> callersByOpp = new Map<Id, List<Id>>();
    Set<Id> callerIds = new Set<Id>();
    for (Opportunity o : newList) {
      Opportunity old = oldMap == null ? null : oldMap.get(o.Id);
      if (!qualifies(o, def) || qualifies(old, def))
        continue;
      List<Id> callers = GSquareSalesArenaWrapperWallTV_V2.creditedOwners(o, def);
      if (!callers.isEmpty()) {
        callersByOpp.put(o.Id, callers);
        callerIds.addAll(callers);
      }
    }
    if (callersByOpp.isEmpty())
      return;

    Map<Id, User> users = new Map<Id, User>(
      (List<User>) Database.query(
        'SELECT Id, Name, Manager.Name, ' +
          GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE +
          ', ' +
          GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PHOTO +
          ' FROM User WHERE Id IN :callerIds'
      )
    );
    Map<Id, String> projects = projectNames(callersByOpp.keySet());
    Map<Id, String> photos = photoUrls(users.values());

    List<GSquare_Arena_Booking__e> events = new List<GSquare_Arena_Booking__e>();
    for (Id oppId : callersByOpp.keySet()) {
      for (Id callerId : callersByOpp.get(oppId)) {
        User u = users.get(callerId);
        if (u == null)
          continue;
        events.add(
          new GSquare_Arena_Booking__e(
            Opportunity_Id__c = String.valueOf(oppId),
            Caller_Id__c = String.valueOf(u.Id),
            Caller_Name__c = u.Name,
            Caller_Initials__c = GSquareSalesArenaServiceWallTV_V2.initialsOf(u.Name),
            Photo_Url__c = photos.get(u.Id),
            Tl_Name__c = u.Manager == null ? null : u.Manager.Name,
            // seating groups ('Chennai;Coimbatore'), so each group's TV celebrates its own
            Zone__c = String.join(
              GSquareSalesArenaWrapperWallTV_V2.zoneGroupsOf(
                (String) u.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_ZONE)
              ),
              ';'
            ),
            Project__c = projects.get(oppId)
          )
        );
      }
    }
    if (events.isEmpty())
      return;
    EventBus.publish(events);
    if (Test.isRunningTest())
      published.addAll(events);
  }

  private static Map<Id, String> projectNames(Set<Id> oppIds) {
    Map<Id, String> out = new Map<Id, String>();
    if (String.isBlank(PROJECT_FIELD))
      return out;
    for (
      SObject o : Database.query(
        'SELECT Id, ' + PROJECT_FIELD + ' FROM Opportunity WHERE Id IN :oppIds'
      )
    ) {
      SObject cur = o;
      List<String> path = PROJECT_FIELD.split('\\.');
      for (Integer i = 0; i < path.size() - 1 && cur != null; i++)
        cur = cur.getSObject(path[i]);
      if (cur != null)
        out.put(o.Id, String.valueOf(cur.get(path[path.size() - 1])));
    }
    return out;
  }

  private static Map<Id, String> photoUrls(List<User> users) {
    Map<Id, String> docByUser = new Map<Id, String>();
    for (User u : users) {
      String doc = GSquareSalesArenaServiceWallTV_V2.extractDocumentId(
        (String) u.get(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PHOTO)
      );
      if (doc != null)
        docByUser.put(u.Id, doc.left(15));
    }
    Map<Id, String> out = new Map<Id, String>();
    if (docByUser.isEmpty())
      return out;
    Set<String> docIds = new Set<String>(docByUser.values());
    Map<String, Id> versionByDoc = new Map<String, Id>();
    for (ContentDocument d : [
      SELECT Id, LatestPublishedVersionId
      FROM ContentDocument
      WHERE Id IN :docIds
    ]) {
      versionByDoc.put(
        String.valueOf(d.Id).left(15),
        d.LatestPublishedVersionId
      );
    }
    for (Id uid : docByUser.keySet())
      out.put(
        uid,
        GSquareSalesArenaServiceWallTV_V2.renditionUrl(
          versionByDoc.get(docByUser.get(uid))
        )
      );
    return out;
  }
}
