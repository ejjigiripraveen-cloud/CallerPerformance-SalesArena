import { buildWorkbookXml } from "c/gsquareArenaLogic";

describe("buildWorkbookXml", () => {
  it("writes one worksheet per sheet with a bold header row", () => {
    const xml = buildWorkbookXml([
      { name: "Summary", rows: [["Metric", "MTD count"], ["Booking", "3"]] },
      { name: "Booking", rows: [["Booking Reference Number"], ["BR-001"]] }
    ]);
    expect(xml).toContain('<Worksheet ss:Name="Summary">');
    expect(xml).toContain('<Worksheet ss:Name="Booking">');
    expect(xml).toContain(
      '<Cell ss:StyleID="h"><Data ss:Type="String">Metric</Data></Cell>'
    );
    expect(xml).toContain('<Cell><Data ss:Type="String">BR-001</Data></Cell>');
  });

  it("escapes XML and cleans sheet names", () => {
    const xml = buildWorkbookXml([
      { name: "A/B: very long sheet name that Excel would reject", rows: [["<x> & \"y\""], [null]] }
    ]);
    expect(xml).toContain("&lt;x&gt; &amp; &quot;y&quot;");
    expect(xml).toContain('ss:Name="A B  very long sheet name that "');
    expect(xml).toContain('<Data ss:Type="String"></Data>');
  });
});
