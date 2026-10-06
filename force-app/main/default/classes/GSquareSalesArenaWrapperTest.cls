@IsTest
private class GSquareSalesArenaWrapperTest {

    private static Map<String, GSquareSalesArenaWrapper.MetricDef> byKey(List<GSquareSalesArenaWrapper.MetricDef> defs) {
        Map<String, GSquareSalesArenaWrapper.MetricDef> m = new Map<String, GSquareSalesArenaWrapper.MetricDef>();
        for (GSquareSalesArenaWrapper.MetricDef d : defs) m.put(d.key, d);
        return m;
    }

    @IsTest
    static void defaultsCoverEveryBoardMetric() {
        Map<String, GSquareSalesArenaWrapper.MetricDef> m = byKey(GSquareSalesArenaWrapper.getMetrics());
        for (String k : new List<String>{ 'allocation', 'svScheduled', 'svConducted', 'booking', 'talktime' }) {
            System.assert(m.containsKey(k), 'missing metric ' + k);
            System.assert(String.isNotBlank(m.get(k).objectApi), k + ' has no object');
        }
        System.assertEquals('SV_User__c', m.get('booking').ownerFieldAlt);
        System.assertEquals(GSquareSalesArenaWrapper.HERO_METRIC_KEYS.size(), 3);
        for (String k : GSquareSalesArenaWrapper.HERO_METRIC_KEYS) System.assert(m.containsKey(k), 'hero key ' + k);
    }

    @IsTest
    static void customMetadataOverridesMerge() {
        List<GSquareSalesArenaWrapper.MetricDef> defaults = GSquareSalesArenaWrapper.getMetrics();
        List<GSquareSalesArenaMetric__mdt> overrides = new List<GSquareSalesArenaMetric__mdt>{
            new GSquareSalesArenaMetric__mdt(DeveloperName = 'A_relabel', Metric_Key__c = 'allocation',
                Metric_Label__c = 'Leads qualified', Unit__c = '', Status_Values__c = 'New, Working',
                Extra_Filter__c = 'IsConverted = false', Min_Volume_JSON__c = '{"tl": 5}'),
            new GSquareSalesArenaMetric__mdt(DeveloperName = 'B_blank', Metric_Key__c = null),
            new GSquareSalesArenaMetric__mdt(DeveloperName = 'C_dupe', Metric_Key__c = 'allocation', Metric_Label__c = 'Ignored'),
            new GSquareSalesArenaMetric__mdt(DeveloperName = 'D_badjson', Metric_Key__c = 'talktime', Min_Volume_JSON__c = '{not json'),
            new GSquareSalesArenaMetric__mdt(DeveloperName = 'E_nolabel', Metric_Key__c = 'brandNew')
        };
        Map<String, GSquareSalesArenaWrapper.MetricDef> m = byKey(GSquareSalesArenaWrapper.mergeMetrics(defaults, overrides));

        System.assertEquals('Leads qualified', m.get('allocation').label);
        System.assertEquals(new List<String>{ 'New', 'Working' }, m.get('allocation').statusValues);
        System.assertEquals(5, m.get('allocation').minVolumeByTier.get('tl'));
        System.assert(!m.containsKey('brandNew'), 'record without label/displayOrder is rejected');
        String warnings = String.join(GSquareSalesArenaWrapper.getConfigWarnings(), ' | ');
        System.assert(warnings.contains('B_blank'), warnings);
        System.assert(warnings.contains('C_dupe'), warnings);
        System.assert(warnings.contains('D_badjson'), warnings);
    }

    @IsTest
    static void personAccumulatesTodayAndMtd() {
        GSquareSalesArenaWrapper.PersonDTO p = new GSquareSalesArenaWrapper.PersonDTO(UserInfo.getUserId(), 'Test User');
        p.add('svConducted', 1);
        p.add('svConducted', 2);
        p.addMtd('svConducted', 5);
        System.assertEquals(3, p.metrics.get('svConducted'));
        System.assertEquals(5, p.mtdMetrics.get('svConducted'));
        System.assertEquals(GSquareSalesArenaWrapper.UNASSIGNED, p.tlName);
    }
}
