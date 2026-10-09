/**
 * =============================================================================
 *  GSquareSalesArenaControllerWallTV_V2 -- the only @AuraEnabled surface
 * =============================================================================
 *  One method, one round trip, one payload. Every LWC component consumes slices
 *  of the same DashboardDTO, so the dashboard never issues duplicate queries for
 *  the same field.
 * =============================================================================
 */
public without sharing class GSquareSalesArenaControllerWallTV_V2 {

    @TestVisible private static Boolean forceFailure = false;   // lets a test cover the error path

    /** The zone dropdown: Gsquare (everyone), then the telecaller seating groups. */
    @AuraEnabled(cacheable=true)
    public static List<String> getZoneGroups() {
        return GSquareSalesArenaWrapperWallTV_V2.zoneDropdown();
    }

    /** TEMPORARY: month-to-date detail behind the tiles, for the Export MTD button. */
    @AuraEnabled
    public static GSquareArenaMtdExport.Result getMtdExport(String zone) {
        try {
            if (Test.isRunningTest() && forceFailure) throw new IllegalArgumentException('forced');
            return GSquareArenaMtdExport.build(zone);
        } catch (Exception e) {
            System.debug(LoggingLevel.ERROR, 'GSquareSalesArenaControllerWallTV_V2.getMtdExport failed: '
                + e.getMessage() + ' | ' + e.getStackTraceString());
            throw new AuraHandledException('Export failed. Please try again.');
        }
    }

    @AuraEnabled(cacheable=true)
    /** @param zone the TV page's Zone__c value; blank returns zoneConfigured = false. */
    public static GSquareSalesArenaWrapperWallTV_V2.DashboardDTO getDashboard(String zone) {
        try {
            if (Test.isRunningTest() && forceFailure) throw new IllegalArgumentException('forced');
            return new GSquareSalesArenaServiceWallTV_V2().build(zone);
        } catch (Exception e) {
            // FIX (audit finding #17): the previous message included raw
            // e.getMessage() and e.getLineNumber(), leaking internal
            // implementation detail (occasionally including field/object names
            // from dynamic SOQL) to the browser console. Full detail now goes
            // to a server-side debug log only; the client gets a generic,
            // actionable message.
            System.debug(LoggingLevel.ERROR, 'GSquareSalesArenaControllerWallTV_V2.getDashboard failed: '
                + e.getMessage() + ' | line ' + e.getLineNumber() + ' | ' + e.getStackTraceString());
            throw new AuraHandledException(
                'Sales Arena is temporarily unavailable. Please try again.'
            );
        }
    }

}