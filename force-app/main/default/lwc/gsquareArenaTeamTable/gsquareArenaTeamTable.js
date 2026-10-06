import { LightningElement, api } from "lwc";

export default class GsquareArenaTeamTable extends LightningElement {
  @api rows = [];
  @api showPace = false;

  get views() {
    return (this.rows || []).map((r) => ({
      ...r,
      talktimeText: `${Math.round(r.talktime || 0)}m`,
      paceText: r.pace ? r.pace.text : "",
      paceClass: `pace ${r.pace ? r.pace.tone : ""}`.trim()
    }));
  }
}
