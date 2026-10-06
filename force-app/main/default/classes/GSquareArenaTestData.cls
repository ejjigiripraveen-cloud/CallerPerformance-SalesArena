/** Shared test data for the Sales Arena zone TV wall tests. */
@IsTest
public class GSquareArenaTestData {
  public static User newUser(
    String alias,
    Id profileId,
    String zone,
    Id managerId
  ) {
    User u = new User(
      Alias = alias,
      Username = alias + '.' + System.currentTimeMillis() + '@arena.test',
      Email = alias + '@arena.test',
      LastName = alias,
      FirstName = 'Test',
      ProfileId = profileId,
      ManagerId = managerId,
      TimeZoneSidKey = 'Asia/Kolkata',
      LocaleSidKey = 'en_IN',
      EmailEncodingKey = 'UTF-8',
      LanguageLocaleKey = 'en_US'
    );
    u.put(GSquareSalesArenaWrapper.USER_FLD_ZONE, zone);
    u.put(GSquareSalesArenaWrapper.USER_FLD_AVAILABILITY, true);
    return u;
  }

  public static Boolean isDateTimeField(String objectApi, String fieldApi) {
    return Schema.getGlobalDescribe()
        .get(objectApi)
        .getDescribe()
        .fields.getMap()
        .get(fieldApi.toLowerCase())
        .getDescribe()
        .getType() == Schema.DisplayType.DATETIME;
  }

  /** Sets a Date or DateTime field to the given IST wall-clock moment. */
  public static void setIst(
    SObject rec,
    String fieldApi,
    Date d,
    Integer hour,
    Integer minute
  ) {
    if (isDateTimeField(String.valueOf(rec.getSObjectType()), fieldApi)) {
      rec.put(fieldApi, GSquareArenaBaselineJob.istToGmt(d, hour, minute));
    } else {
      rec.put(fieldApi, d);
    }
  }

  public static SObject conductedVisit(
    Id scheduledBy,
    Date d,
    Integer hour,
    Integer minute
  ) {
    SObject sv = Schema.getGlobalDescribe().get('Site_Visit__c').newSObject();
    sv.put('Scheduled_By__c', scheduledBy);
    sv.put('Status__c', 'Conducted');
    setIst(sv, 'Conducted_On__c', d, hour, minute);
    return sv;
  }
}
