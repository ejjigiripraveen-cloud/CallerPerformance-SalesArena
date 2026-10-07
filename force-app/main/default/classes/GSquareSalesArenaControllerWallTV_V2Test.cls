@IsTest
private class GSquareSalesArenaControllerWallTV_V2Test {

    @IsTest
    static void blankZoneIsNotConfigured() {
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = GSquareSalesArenaControllerWallTV_V2.getDashboard(null);
        System.assertEquals(false, dto.zoneConfigured);
        System.assertEquals(0, dto.people.size());
        System.assertNotEquals(null, dto.metricDefs);
    }

    @IsTest
    static void unknownZoneReturnsEmptyBoards() {
        GSquareSalesArenaWrapperWallTV_V2.DashboardDTO dto = GSquareSalesArenaControllerWallTV_V2.getDashboard('No Such Zone 9z');
        System.assertEquals(true, dto.zoneConfigured);
        System.assertEquals('No Such Zone 9z', dto.zone);
        System.assertEquals(0, dto.people.size());
        System.assertEquals(0, dto.totals.get('svConducted'));
    }
}
