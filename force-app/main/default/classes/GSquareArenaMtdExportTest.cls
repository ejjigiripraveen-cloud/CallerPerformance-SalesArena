@IsTest
private class GSquareArenaMtdExportTest {
  @TestSetup
  static void setup() {
    Profile caller = [SELECT Id FROM Profile WHERE Name = 'Presales outbound' LIMIT 1];
    Profile tlProfile = [SELECT Id FROM Profile WHERE Name = 'Presales TL' LIMIT 1];
    Profile admin = [SELECT Id FROM Profile WHERE Name = 'System Administrator' LIMIT 1];
    System.runAs(new User(Id = UserInfo.getUserId())) {
      // runs the export: Asia/Kolkata so THIS_MONTH matches the IST test data
      insert GSquareArenaTestData.newUser('armadm', admin.Id, null, null);
      User tl = GSquareArenaTestData.newUser('armtl', tlProfile.Id, 'Ambur', null);
      insert tl;
      insert new List<User>{
        GSquareArenaTestData.newUser('armc1', caller.Id, 'Ambur', tl.Id),
        GSquareArenaTestData.newUser('armc2', caller.Id, 'Pune', tl.Id)
      };
    }
  }

  private static User u(String alias) {
    return [SELECT Id, Name FROM User WHERE Alias = :alias LIMIT 1];
  }

  private static GSquareArenaMtdExport.Result exportAs(String zone) {
    GSquareArenaMtdExport.Result res;
    System.runAs(u('armadm')) {
      res = GSquareArenaMtdExport.build(zone);
    }
    return res;
  }

  private static GSquareArenaMtdExport.Sheet sheet(GSquareArenaMtdExport.Result res, String name) {
    for (GSquareArenaMtdExport.Sheet s : res.sheets)
      if (s.name == name)
        return s;
    return null;
  }

  private static Set<String> callersOn(GSquareArenaMtdExport.Sheet s, Integer col) {
    Set<String> out = new Set<String>();
    for (Integer i = 1; i < s.rows.size(); i++)
      out.add(s.rows[i][col]);
    return out;
  }

  @IsTest
  static void exportsThisZonesConductedVisits() {
    Date today = GSquareArenaBaselineJob.istToday();
    insert new List<SObject>{
      GSquareArenaTestData.conductedVisit(u('armc1').Id, today, 10, 0),
      GSquareArenaTestData.conductedVisit(u('armc2').Id, today, 11, 0)
    };
    Test.startTest();
    GSquareArenaMtdExport.Result res = exportAs('Chennai');
    Test.stopTest();

    System.assertEquals('Chennai', res.zone);
    System.assertEquals(4, res.sheets.size(), 'Summary, Allocation, SV Conducted, Booking');
    GSquareArenaMtdExport.Sheet sv = sheet(res, 'SV Conducted');
    Set<String> credited = callersOn(sv, 6);
    System.assert(credited.contains(u('armc1').Name), 'Chennai caller exported');
    System.assert(!credited.contains(u('armc2').Name), 'Pune caller left out');
    // the summary count is the sheet's row count
    GSquareArenaMtdExport.Sheet summary = sheet(res, 'Summary');
    System.assertEquals('SV Conducted', summary.rows[2][0]);
    System.assertEquals(String.valueOf(sv.rows.size() - 1), summary.rows[2][1]);
    // header rows carry the verification columns
    System.assertEquals('Booking Reference Number', sheet(res, 'Booking').rows[0][1]);
    System.assertEquals('Flat No', sheet(res, 'Booking').rows[0][5]);
  }

  @IsTest
  static void gsquareExportsEveryZone() {
    Date today = GSquareArenaBaselineJob.istToday();
    insert new List<SObject>{
      GSquareArenaTestData.conductedVisit(u('armc1').Id, today, 10, 0),
      GSquareArenaTestData.conductedVisit(u('armc2').Id, today, 11, 0)
    };
    Test.startTest();
    GSquareArenaMtdExport.Result res = exportAs('Gsquare');
    Test.stopTest();

    Set<String> credited = callersOn(sheet(res, 'SV Conducted'), 6);
    System.assert(credited.contains(u('armc1').Name));
    System.assert(credited.contains(u('armc2').Name));
  }

  @IsTest
  static void noZoneExportsNothing() {
    GSquareArenaMtdExport.Result res = GSquareArenaMtdExport.build(' ');
    System.assertEquals(null, res.zone);
    System.assertEquals(0, res.sheets.size());
  }

  @IsTest
  static void textFormatsValuesAndPaths() {
    Site_Visit__c sv = new Site_Visit__c(Conducted_On__c = Datetime.newInstanceGmt(2026, 10, 9, 4, 30, 0));
    System.assertEquals('09-10-2026 10:00', GSquareArenaMtdExport.text(sv, 'Conducted_On__c'), 'IST');
    System.assertEquals('', GSquareArenaMtdExport.text(sv, 'Status__c'));
    System.assertEquals('', GSquareArenaMtdExport.text(sv, 'Lead__r.Name'), 'missing parent');
    Opportunity o = new Opportunity(Name = 'X', CloseDate = Date.newInstance(2026, 10, 9));
    System.assertEquals('09-10-2026', GSquareArenaMtdExport.text(o, 'CloseDate'));
    System.assertEquals('X', GSquareArenaMtdExport.text(o, 'Name'));
  }

  @IsTest
  static void whereClauseMatchesTheTiles() {
    for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : GSquareSalesArenaWrapperWallTV_V2.getMetrics()) {
      if (d.key == 'booking') {
        String w = GSquareArenaMtdExport.baseWhere(d);
        System.assert(w.startsWith('CreatedDate = THIS_MONTH'), w);
        System.assert(w.contains('Total_Receipts__c > 90000'), w);
        System.assert(w.contains('Total_Receipts__c'), w);
      }
      if (d.key == 'svConducted') {
        System.assert(GSquareArenaMtdExport.baseWhere(d).contains('Status__c IN (\'Conducted\')'));
      }
    }
  }

  @IsTest
  static void controllerWrapsTheExport() {
    System.runAs(u('armadm')) {
      System.assertEquals('Coimbatore', GSquareSalesArenaControllerWallTV_V2.getMtdExport('Hosur').zone);
    }
  }
}
