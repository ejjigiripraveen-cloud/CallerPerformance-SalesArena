@IsTest
private class GSquareSalesArenaWrapperWallTV_V2Test {

    private static Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef> byKey(List<GSquareSalesArenaWrapperWallTV_V2.MetricDef> defs) {
        Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef> m = new Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef>();
        for (GSquareSalesArenaWrapperWallTV_V2.MetricDef d : defs) m.put(d.key, d);
        return m;
    }

    @IsTest
    static void defaultsCoverEveryBoardMetric() {
        Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef> m = byKey(GSquareSalesArenaWrapperWallTV_V2.getMetrics());
        for (String k : new List<String>{ 'allocation', 'svScheduled', 'svConducted', 'booking', 'talktime' }) {
            System.assert(m.containsKey(k), 'missing metric ' + k);
            System.assert(String.isNotBlank(m.get(k).objectApi), k + ' has no object');
        }
        System.assertEquals('SV_User__c', m.get('booking').ownerFieldAlt);
        System.assertEquals(GSquareSalesArenaWrapperWallTV_V2.HERO_METRIC_KEYS.size(), 3);
        for (String k : GSquareSalesArenaWrapperWallTV_V2.HERO_METRIC_KEYS) System.assert(m.containsKey(k), 'hero key ' + k);
    }

    @IsTest
    static void customMetadataOverridesMerge() {
        List<GSquareSalesArenaWrapperWallTV_V2.MetricDef> defaults = GSquareSalesArenaWrapperWallTV_V2.getMetrics();
        List<GSquareArenaTvMetric__mdt> overrides = new List<GSquareArenaTvMetric__mdt>{
            new GSquareArenaTvMetric__mdt(DeveloperName = 'A_relabel', Metric_Key__c = 'allocation',
                Metric_Label__c = 'Leads qualified', Unit__c = '', Status_Values__c = 'New, Working',
                Extra_Filter__c = 'IsConverted = false', Min_Volume_JSON__c = '{"tl": 5}'),
            new GSquareArenaTvMetric__mdt(DeveloperName = 'B_blank', Metric_Key__c = null),
            new GSquareArenaTvMetric__mdt(DeveloperName = 'C_dupe', Metric_Key__c = 'allocation', Metric_Label__c = 'Ignored'),
            new GSquareArenaTvMetric__mdt(DeveloperName = 'D_badjson', Metric_Key__c = 'talktime', Min_Volume_JSON__c = '{not json'),
            new GSquareArenaTvMetric__mdt(DeveloperName = 'E_nolabel', Metric_Key__c = 'brandNew')
        };
        Map<String, GSquareSalesArenaWrapperWallTV_V2.MetricDef> m = byKey(GSquareSalesArenaWrapperWallTV_V2.mergeMetrics(defaults, overrides));

        System.assertEquals('Leads qualified', m.get('allocation').label);
        System.assertEquals(new List<String>{ 'New', 'Working' }, m.get('allocation').statusValues);
        System.assertEquals(5, m.get('allocation').minVolumeByTier.get('tl'));
        System.assert(!m.containsKey('brandNew'), 'record without label/displayOrder is rejected');
        String warnings = String.join(GSquareSalesArenaWrapperWallTV_V2.getConfigWarnings(), ' | ');
        System.assert(warnings.contains('B_blank'), warnings);
        System.assert(warnings.contains('C_dupe'), warnings);
        System.assert(warnings.contains('D_badjson'), warnings);
    }

    @IsTest
    static void zonesOfSplitsMultiSelect() {
        System.assertEquals(new List<String>{ 'Chennai', 'Coimbatore' },
            GSquareSalesArenaWrapperWallTV_V2.zonesOf('Chennai;Coimbatore'));
        System.assertEquals(new List<String>{ 'Ambur' }, GSquareSalesArenaWrapperWallTV_V2.zonesOf('Ambur'));
        System.assertEquals(0, GSquareSalesArenaWrapperWallTV_V2.zonesOf(null).size());
    }

    @IsTest
    static void zonesMapToSeatingGroups() {
        System.assertEquals('Chennai', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Ambur'));
        System.assertEquals('Chennai', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Ranipet'));
        System.assertEquals('Coimbatore', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Hosur'));
        System.assertEquals('Others', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Bangalore'));
        System.assertEquals('Pune', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Pune'));
        System.assertEquals('Goa', GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf('Goa'), 'unmapped zone stays visible');
        System.assertEquals(null, GSquareSalesArenaWrapperWallTV_V2.zoneGroupOf(' '));
        // multi-select collapses to distinct groups, in first-seen order
        System.assertEquals(new List<String>{ 'Chennai', 'Others' },
            GSquareSalesArenaWrapperWallTV_V2.zoneGroupsOf('Ambur;Trichy;Hyderabad;Chennai'));
        System.assertEquals('Coimbatore', GSquareSalesArenaWrapperWallTV_V2.resolveZoneGroup('Coimbatore'));
        System.assertEquals('Coimbatore', GSquareSalesArenaWrapperWallTV_V2.resolveZoneGroup(' Hosur '));
        System.assertEquals(null, GSquareSalesArenaWrapperWallTV_V2.resolveZoneGroup(''));
        System.assertEquals(2, GSquareSalesArenaWrapperWallTV_V2.zonesInGroup('Coimbatore').size());
        System.assertEquals(new List<String>{ 'Goa' }, GSquareSalesArenaWrapperWallTV_V2.zonesInGroup('Goa'));
        // every group in the dropdown has its zone list
        for (String grp : GSquareSalesArenaWrapperWallTV_V2.ZONE_GROUP_ORDER) {
            System.assert(GSquareSalesArenaWrapperWallTV_V2.ZONE_GROUPS.containsKey(grp), grp);
        }
    }

    @IsTest
    static void personAccumulatesTodayAndMtd() {
        GSquareSalesArenaWrapperWallTV_V2.PersonDTO p = new GSquareSalesArenaWrapperWallTV_V2.PersonDTO(UserInfo.getUserId(), 'Test User');
        p.add('svConducted', 1);
        p.add('svConducted', 2);
        p.addMtd('svConducted', 5);
        System.assertEquals(3, p.metrics.get('svConducted'));
        System.assertEquals(5, p.mtdMetrics.get('svConducted'));
        System.assertEquals(GSquareSalesArenaWrapperWallTV_V2.UNASSIGNED, p.tlName);
    }
}
