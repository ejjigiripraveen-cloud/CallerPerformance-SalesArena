@IsTest
private class GSquareSalesArenaServiceWallTV_V2Test {

    @TestSetup
    static void setup() {
        Profile caller = [SELECT Id FROM Profile WHERE Name = 'Presales outbound' LIMIT 1];
        Profile tlProfile = [SELECT Id FROM Profile WHERE Name = 'Presales TL' LIMIT 1];
        Profile admin = [SELECT Id FROM Profile WHERE Name = 'System Administrator' LIMIT 1];
        System.runAs(new User(Id = UserInfo.getUserId())) {
            // runs the build: Asia/Kolkata so TODAY matches the IST test data, and full FLS
            insert GSquareArenaTestData.newUser('arsadm', admin.Id, null, null);
            User tl = GSquareArenaTestData.newUser('arstl', tlProfile.Id, 'Arena Z1', null);
            insert tl;
            insert new List<User>{
                GSquareArenaTestData.newUser('arsc1', caller.Id, 'Arena Z1', tl.Id),
                GSquareArenaTestData.newUser('arsc2', caller.Id, 'Arena Z2', tl.Id)
            };
        }
    }

    private static User u(String alias) {
        return [SELECT Id, Name FROM User WHERE Alias = :alias LIMIT 1];
    }

    private static GSquareSalesArenaWrapperWallTV_V2.DashboardDTO buildAs(String zone) {
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto;
        System.runAs(u('arsadm')) {
            dto = new GSquareSalesArenaServiceWallTV_V2().build(zone);
        }
        return dto;
    }

    @IsTest
    static void blankZoneIsNotConfigured() {
        Test.startTest();
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = new GSquareSalesArenaServiceWallTV_V2().build('  ');
        Test.stopTest();
        System.assertEquals(false, dto.zoneConfigured);
        System.assertEquals(0, dto.people.size());
    }

    @IsTest
    static void filtersByZoneButRacesAllZones() {
        Date today = GSquareArenaBaselineJob.istToday();
        insert new List<SObject>{
            GSquareArenaTestData.conductedVisit(u('arsc1').Id, today, 10, 0),
            GSquareArenaTestData.conductedVisit(u('arsc2').Id, today, 10, 0)
        };
        Test.startTest();
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = buildAs('Arena Z1');
        Test.stopTest();

        System.assertEquals(true, dto.zoneConfigured);
        Set<Id> ids = new Set<Id>();
        for (GSquareSalesArenaWrapperWallTV_V2.PersonDTO p : dto.people) ids.add(p.userId);
        System.assert(ids.contains(u('arsc1').Id), 'Z1 caller present');
        System.assert(!ids.contains(u('arsc2').Id), 'Z2 caller filtered out');

        Map<String, Decimal> race = new Map<String, Decimal>();
        for (GSquareSalesArenaWrapperWallTV_V2.ZoneRaceEntry e : dto.zoneRace) race.put(e.zone, e.svConducted);
        System.assertEquals(1, race.get('Arena Z1'));
        System.assertEquals(1, race.get('Arena Z2'));

        System.assertEquals(2, dto.tlTeamSizes.get(String.valueOf(u('arstl').Id)), 'team size spans zones');
    }

    @IsTest
    static void todayAndMtdTotalsAreSeparate() {
        Date today = GSquareArenaBaselineJob.istToday();
        List<SObject> visits = new List<SObject>{ GSquareArenaTestData.conductedVisit(u('arsc1').Id, today, 10, 0) };
        Boolean hasEarlierDay = today.day() > 1;
        if (hasEarlierDay) visits.add(GSquareArenaTestData.conductedVisit(u('arsc1').Id, today.addDays(-1), 10, 0));
        insert visits;

        Test.startTest();
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = buildAs('Arena Z1');
        Test.stopTest();

        System.assertEquals(1, dto.totals.get('svConducted'));
        System.assertEquals(hasEarlierDay ? 2 : 1, dto.mtdTotals.get('svConducted'));
        System.assert(!dto.mtdTotals.containsKey('talktime'), 'MTD only for hero metrics');
    }

    @IsTest
    static void readsBaselineForTodayAndTl() {
        Date today = GSquareArenaBaselineJob.istToday();
        Integer wd = GSquareArenaBaselineJob.weekdayOf(today);
        String zoneScope = GSquareArenaBaselineJob.zoneScope('Arena Z1');
        String tlScope = GSquareArenaBaselineJob.tlScope('Arena Z1', u('arstl').Id);
        insert new List<GSquare_Arena_Baseline__c>{
            new GSquare_Arena_Baseline__c(Unique_Key__c = GSquareArenaBaselineJob.hourlyKey(zoneScope, 'svConducted', wd, 10),
                Scope_Key__c = zoneScope, Metric_Key__c = 'svConducted', Kind__c = 'HOURLY', Weekday__c = wd, Hour__c = 10, Value__c = 7),
            new GSquare_Arena_Baseline__c(Unique_Key__c = GSquareArenaBaselineJob.hourlyKey(tlScope, 'svConducted', wd, 10),
                Scope_Key__c = tlScope, Metric_Key__c = 'svConducted', Kind__c = 'HOURLY', Weekday__c = wd, Hour__c = 10, Value__c = 3),
            new GSquare_Arena_Baseline__c(Unique_Key__c = GSquareArenaBaselineJob.mtdKey(zoneScope, 'booking', today.day()),
                Scope_Key__c = zoneScope, Metric_Key__c = 'booking', Kind__c = 'MTD', Day_Of_Month__c = today.day(), Value__c = 9)
        };
        Test.startTest();
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = buildAs('Arena Z1');
        Test.stopTest();

        System.assertEquals(7, dto.baseline.hourly.get('svConducted')[10]);
        System.assertEquals(24, dto.baseline.hourly.get('svConducted').size());
        System.assertEquals(9, dto.baseline.lastMonthToDate.get('booking'));
        System.assertEquals(3, dto.baseline.tlHourly.get(String.valueOf(u('arstl').Id))[10]);
    }

    @IsTest
    static void photoUrlParsing() {
        String raw = 'https://gsquaregroup.lightning.force.com/lightning/r/ContentDocument/069AB000001abcDEFG/view';
        System.assertEquals('069AB000001abcDEFG', GSquareSalesArenaServiceWallTV_V2.extractDocumentId(raw));
        System.assertEquals(null, GSquareSalesArenaServiceWallTV_V2.extractDocumentId(null));
        System.assertEquals(null, GSquareSalesArenaServiceWallTV_V2.extractDocumentId('https://example.com/photo.png'));
        Id versionId = '068AB000001abcD'; // 15-char: no checksum to fake
        System.assertEquals(
            '/sfc/servlet.shepherd/version/renditionDownload?rendition=THUMB240BY180&versionId=' + versionId,
            GSquareSalesArenaServiceWallTV_V2.renditionUrl(versionId)
        );
        System.assertEquals(null, GSquareSalesArenaServiceWallTV_V2.renditionUrl(null));
    }

    @IsTest
    static void initials() {
        System.assertEquals('PR', GSquareSalesArenaServiceWallTV_V2.initialsOf('Priya Ramesh'));
        System.assertEquals('PR', GSquareSalesArenaServiceWallTV_V2.initialsOf('priya k ramesh'));
        System.assertEquals('M', GSquareSalesArenaServiceWallTV_V2.initialsOf('Madonna'));
        System.assertEquals('', GSquareSalesArenaServiceWallTV_V2.initialsOf(null));
    }
}
