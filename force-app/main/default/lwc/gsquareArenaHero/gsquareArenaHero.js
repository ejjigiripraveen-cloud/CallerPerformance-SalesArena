import { LightningElement, api } from "lwc";

const fmt = new Intl.NumberFormat("en-IN");

export default class GsquareArenaHero extends LightningElement {
  @api zoneName;
  @api clockText;
  @api ampm;
  @api dateText;
  @api tiles = [];
  @api updatedText;
  @api staleState = "fresh";

  get updatedClass() {
    return `updated ${this.staleState === "fresh" ? "" : this.staleState}`.trim();
  }

  get tileViews() {
    return (this.tiles || []).map((t) => ({
      key: t.key,
      label: t.label,
      tone: (t.pace && t.pace.tone) || "neutral",
      today: fmt.format(t.today || 0),
      paceText: (t.pace && t.pace.text) || "",
      mtdText: fmt.format(t.mtd || 0),
      mtdDelta: (t.mtdState && t.mtdState.text) || "",
      mtdClass: `d ${(t.mtdState && t.mtdState.tone) || "neutral"}`
    }));
  }
}
