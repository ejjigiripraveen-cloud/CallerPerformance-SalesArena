import { LightningElement, api } from "lwc";

export default class GsquareArenaBoard extends LightningElement {
  @api rows = [];
  @api variant = "top"; // 'top' | 'bottom'
  @api unit = "";

  get isBottom() {
    return this.variant === "bottom";
  }

  get boardClass() {
    return this.isBottom ? "board bottom" : "board";
  }

  get columns() {
    const views = (this.rows || []).map((r) => this.view(r));
    if (this.isBottom) return [{ key: "c1", rows: views }];
    return [
      { key: "c1", rows: views.slice(0, 5) },
      { key: "c2", rows: views.slice(5, 10) }
    ];
  }

  view(r) {
    const m = this.isBottom ? null : r.movement;
    return {
      ...r,
      rowClass: r.rank === 1 && !this.isBottom ? "row first" : "row",
      mvText: !m ? "" : m > 0 ? `\u25B2${m}` : `\u25BC${-m}`,
      mvClass: !m ? "mv" : m > 0 ? "mv up" : "mv down",
      valText: `${Math.round(r.value)}${this.unit || ""}`,
      valClass: this.isBottom && r.value === 0 ? "val num zero" : "val num"
    };
  }
}
