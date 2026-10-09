@IsTest
private class GSquareArenaBaselineJobTest {
  private static final String ZONE = 'Pune'; // a group of one, so scope keys use the same name

  @TestSetup
  static void setup() {
    Profile caller = [
      SELECT Id
      FROM Profile
      WHERE Name = 'Presales outbound'
      LIMIT 1
    ];
    Profile tlProfile = [
      SELECT Id
      FROM Profile
      WHERE Name = 'Presales TL'
      LIMIT 1
    ];
    System.runAs(new User(Id = UserInfo.getUserId())) {
      User tl = GSquareArenaTestData.newUser(
        'arenatl',
        tlProfile.Id,
        ZONE,
        null
      );
      insert tl;
      insert GSquareArenaTestData.newUser('arenac1', caller.Id, ZONE, tl.Id);
    }
  }

  private static Id callerId() {
    return [SELECT Id FROM User WHERE Alias = 'arenac1' LIMIT 1].Id;
  }

  private static Id tlId() {
    return [SELECT Id FROM User WHERE Alias = 'arenatl' LIMIT 1].Id;
  }

  private static Decimal valueFor(String uniqueKey) {
    List<GSquare_Arena_Baseline__c> rows = [
      SELECT Value__c
      FROM GSquare_Arena_Baseline__c
      WHERE Unique_Key__c = :uniqueKey
    ];
    return rows.isEmpty() ? null : rows[0].Value__c;
  }

  @IsTest
  static void hourlyBaselineAveragesFourSameWeekdays() {
    Date target = Date.newInstance(2026, 10, 6); // a Tuesday
    List<SObject> visits = new List<SObject>();
    for (Integer w = 1; w <= 4; w++) {
      Date d = target.addDays(-7 * w);
      for (Integer i = 0; i < 2; i++) {
        visits.add(GSquareArenaTestData.conductedVisit(callerId(), d, 10, 15));
      }
    }
    insert visits;

    Test.startTest();
    GSquareArenaBaselineJob.computeFor(target);
    Test.stopTest();

    String zoneScope = 'ZONE:' + ZONE;
    Integer weekday = GSquareArenaBaselineJob.weekdayOf(target);
    if (
      GSquareArenaTestData.isDateTimeField('Site_Visit__c', 'Conducted_On__c')
    ) {
      System.assertEquals(
        0,
        valueFor(
          GSquareArenaBaselineJob.hourlyKey(
            zoneScope,
            'svConducted',
            weekday,
            9
          )
        )
      );
      System.assertEquals(
        2,
        valueFor(
          GSquareArenaBaselineJob.hourlyKey(
            zoneScope,
            'svConducted',
            weekday,
            10
          )
        )
      );
      System.assertEquals(
        2,
        valueFor(
          GSquareArenaBaselineJob.hourlyKey(
            zoneScope,
            'svConducted',
            weekday,
            23
          )
        )
      );
    } else {
      // Date-only field: day total ramps evenly across office hours
      System.assertEquals(
        0,
        valueFor(
          GSquareArenaBaselineJob.hourlyKey(
            zoneScope,
            'svConducted',
            weekday,
            8
          )
        )
      );
      System.assertEquals(
        2,
        valueFor(
          GSquareArenaBaselineJob.hourlyKey(
            zoneScope,
            'svConducted',
            weekday,
            19
          )
        )
      );
    }
    String tlScope = 'TL:' + ZONE + ':' + tlId();
    System.assertEquals(
      valueFor(
        GSquareArenaBaselineJob.hourlyKey(zoneScope, 'svConducted', weekday, 23)
      ),
      valueFor(
        GSquareArenaBaselineJob.hourlyKey(tlScope, 'svConducted', weekday, 23)
      ),
      'TL scope equals zone scope when every caller is in the zone'
    );
    System.assertEquals(
      valueFor(
        GSquareArenaBaselineJob.hourlyKey(zoneScope, 'svConducted', weekday, 23)
      ),
      valueFor(
        GSquareArenaBaselineJob.hourlyKey(
          GSquareArenaBaselineJob.zoneScope('Gsquare'),
          'svConducted',
          weekday,
          23
        )
      ),
      'the Gsquare (all zones) baseline includes this zone'
    );
  }

  @IsTest
  static void mtdCapsAtLastMonthLength() {
    Date target = Date.newInstance(2026, 3, 31);
    insert new List<SObject>{
      GSquareArenaTestData.conductedVisit(
        callerId(),
        Date.newInstance(2026, 2, 1),
        11,
        0
      ),
      GSquareArenaTestData.conductedVisit(
        callerId(),
        Date.newInstance(2026, 2, 28),
        11,
        0
      ),
      GSquareArenaTestData.conductedVisit(
        callerId(),
        Date.newInstance(2026, 1, 31),
        11,
        0
      ),
      GSquareArenaTestData.conductedVisit(
        callerId(),
        Date.newInstance(2026, 3, 1),
        11,
        0
      )
    };

    Test.startTest();
    GSquareArenaBaselineJob.computeFor(target);
    Test.stopTest();

    System.assertEquals(
      2,
      valueFor(
        GSquareArenaBaselineJob.mtdKey('ZONE:' + ZONE, 'svConducted', 31)
      )
    );
  }

  @IsTest
  static void rerunUpdatesWithoutDuplicates() {
    Date target = Date.newInstance(2026, 10, 6);
    Test.startTest();
    GSquareArenaBaselineJob.computeFor(target);
    Integer first = [SELECT COUNT() FROM GSquare_Arena_Baseline__c];
    GSquareArenaBaselineJob.computeFor(target);
    Test.stopTest();
    System.assert(first > 0, 'rows written');
    System.assertEquals(first, [SELECT COUNT() FROM GSquare_Arena_Baseline__c]);
  }

  @IsTest
  static void schedulesNightly() {
    Test.startTest();
    String jobId = GSquareArenaBaselineJob.scheduleNightly();
    Test.stopTest();
    System.assertNotEquals(null, jobId);
  }

  @IsTest
  static void runAsyncSplitsWorkIntoQueueableSteps() {
    Date target = Date.newInstance(2026, 10, 6);
    System.assertEquals(
      8,
      GSquareArenaBaselineJob.steps().size(),
      '4 metrics x (hourly, mtd)'
    );
    Test.startTest();
    Id jobId = GSquareArenaBaselineJob.runAsync(target);
    Test.stopTest();
    System.assertNotEquals(null, jobId);
    String firstMetric = GSquareArenaBaselineJob.steps()[0][0];
    System.assert(
      [
        SELECT COUNT()
        FROM GSquare_Arena_Baseline__c
        WHERE Metric_Key__c = :firstMetric AND Kind__c = 'HOURLY'
      ] > 0,
      'first step ran'
    );
  }
}
