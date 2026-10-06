@IsTest
private class GSquareSalesArenaControllerTest {

    @IsTest
    static void blankZoneIsNotConfigured() {
        GSquareSalesArenaWrapper.DashboardDTO dto = GSquareSalesArenaController.getDashboard(null);
        System.assertEquals(false, dto.zoneConfigured);
        System.assertEquals(0, dto.people.size());
        System.assertNotEquals(null, dto.metricDefs);
    }

    @IsTest
    static void unknownZoneReturnsEmptyBoards() {
        GSquareSalesArenaWrapper.DashboardDTO dto = GSquareSalesArenaController.getDashboard('No Such Zone 9z');
        System.assertEquals(true, dto.zoneConfigured);
        System.assertEquals('No Such Zone 9z', dto.zone);
        System.assertEquals(0, dto.people.size());
        System.assertEquals(0, dto.totals.get('svConducted'));
    }
}
