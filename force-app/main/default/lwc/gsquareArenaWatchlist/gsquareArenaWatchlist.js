import { LightningElement, api } from "lwc";

export default class GsquareArenaWatchlist extends LightningElement {
  @api rows = [];

  get hasRows() {
    return (this.rows || []).length > 0;
  }

  get views() {
    return this.rows.map((w) => ({
      ...w,
      rowClass: w.severity === "critical" ? "wrow critical" : "wrow",
      why: w.reasons
        .map((r) => `${r.metric} ${r.value}${r.unit || ""}`)
        .join(", ")
    }));
  }
}
