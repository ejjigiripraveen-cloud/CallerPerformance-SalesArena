@IsTest
private class GSquareArenaBookingEventsTest {
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
        'arbtl',
        tlProfile.Id,
        'Ambur',
        null
      );
      insert tl;
      insert new List<User>{
        GSquareArenaTestData.newUser('arbc1', caller.Id, 'Ambur', tl.Id),
        GSquareArenaTestData.newUser('arbsv', caller.Id, 'Ranipet', tl.Id)
      };
    }
  }

  private static Id uid(String alias) {
    return [SELECT Id FROM User WHERE Alias = :alias LIMIT 1].Id;
  }

  /** In-memory Opportunity; JSON lets us set roll-up/formula fields. */
  private static Opportunity opp(
    String idSuffix,
    Decimal receipts,
    String stage,
    Date bookingDate,
    Id presales,
    Id svUser
  ) {
    Map<String, Object> m = new Map<String, Object>{
      'attributes' => new Map<String, Object>{ 'type' => 'Opportunity' },
      'Id' => '006000000000' + idSuffix,
      'Name' => 'Test booking',
      'StageName' => stage,
      'Total_Receipts__c' => receipts,
      'Presales_Owner__c' => presales,
      'SV_User__c' => svUser
    };
    m.put(
      'Booking_Date__c',
      GSquareArenaTestData.isDateTimeField('Opportunity', 'Booking_Date__c')
        ? (Object) GSquareArenaBaselineJob.istToGmt(bookingDate, 12, 0)
        : (Object) bookingDate
    );
    return (Opportunity) JSON.deserialize(JSON.serialize(m), Opportunity.class);
  }

  private static Date today() {
    return GSquareArenaBaselineJob.istToday();
  }

  @IsTest
  static void newQualifyingBookingPublishesOnce() {
    Opportunity o = opp('001', 95000, 'Booked', today(), uid('arbc1'), null);
    Test.startTest();
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{ o },
      null
    );
    Test.stopTest();
    System.assertEquals(1, GSquareArenaBookingEvents.published.size());
    GSquare_Arena_Booking__e e = GSquareArenaBookingEvents.published[0];
    System.assertEquals(String.valueOf(o.Id), e.Opportunity_Id__c);
    System.assertEquals(String.valueOf(uid('arbc1')), e.Caller_Id__c);
    System.assertEquals('Ambur', e.Zone__c);
  }

  @IsTest
  static void alreadyQualifiedUpdateDoesNotRepublish() {
    Opportunity before = opp(
      '002',
      95000,
      'Booked',
      today(),
      uid('arbc1'),
      null
    );
    Opportunity after = opp(
      '002',
      120000,
      'Booked',
      today(),
      uid('arbc1'),
      null
    );
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{ after },
      new Map<Id, Opportunity>{ before.Id => before }
    );
    System.assertEquals(0, GSquareArenaBookingEvents.published.size());
  }

  @IsTest
  static void crossingTheThresholdPublishes() {
    Opportunity before = opp(
      '003',
      50000,
      'Booked',
      today(),
      uid('arbc1'),
      null
    );
    Opportunity after = opp(
      '003',
      90000,
      'Booked',
      today(),
      uid('arbc1'),
      null
    );
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{ after },
      new Map<Id, Opportunity>{ before.Id => before }
    );
    System.assertEquals(1, GSquareArenaBookingEvents.published.size());
  }

  @IsTest
  static void cancelledOrOtherDayIsIgnored() {
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{
        opp(
          '004',
          95000,
          GSquareSalesArenaWrapperWallTV_V2.BOOKING_EXCLUDED_STAGE,
          today(),
          uid('arbc1'),
          null
        ),
        opp('005', 95000, 'Booked', today().addDays(-1), uid('arbc1'), null)
      },
      null
    );
    System.assertEquals(0, GSquareArenaBookingEvents.published.size());
  }

  @IsTest
  static void fallsBackToSvUser() {
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{
        opp('006', 95000, 'Booked', today(), null, uid('arbsv'))
      },
      null
    );
    System.assertEquals(1, GSquareArenaBookingEvents.published.size());
    System.assertEquals(
      String.valueOf(uid('arbsv')),
      GSquareArenaBookingEvents.published[0].Caller_Id__c
    );
    System.assertEquals(
      'Ranipet',
      GSquareArenaBookingEvents.published[0].Zone__c
    );
  }

  @IsTest
  static void carriesPhotoAndProject() {
    ContentVersion cv = new ContentVersion(
      Title = 'arena photo',
      PathOnClient = 'arena.png',
      VersionData = Blob.valueOf('png')
    );
    insert cv;
    Id docId = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id]
    .ContentDocumentId;
    User caller = new User(Id = uid('arbc1'));
    // The org field is Text(18): it holds the bare ContentDocument Id.
    caller.put(GSquareSalesArenaWrapperWallTV_V2.USER_FLD_PHOTO, String.valueOf(docId));
    System.runAs(new User(Id = UserInfo.getUserId())) {
      update caller;
    }
    GSquareArenaBookingEvents.PROJECT_FIELD = 'Name';
    GSquareArenaBookingEvents.publishNewBookings(
      new List<Opportunity>{
        opp('007', 95000, 'Booked', today(), uid('arbc1'), null)
      },
      null
    );
    System.assertEquals(1, GSquareArenaBookingEvents.published.size());
    System.assert(
      GSquareArenaBookingEvents.published[0].Photo_Url__c.contains('versionId='),
      GSquareArenaBookingEvents.published[0].Photo_Url__c
    );
  }

  /** Real DML so GSquareArenaBookingTrigger runs; a non-booking stage publishes nothing. */
  @IsTest
  static void triggerRunsOnInsertAndUpdate() {
    Opportunity o = new Opportunity(
      Name = 'Arena trigger test',
      StageName = '1.Site Tour Completed',
      CloseDate = today()
    );
    Test.startTest();
    insert o;
    o.CloseDate = today().addDays(1);
    update o;
    Test.stopTest();
    System.assertEquals(0, GSquareArenaBookingEvents.published.size());
  }
}
