import { LightningElement, api } from "lwc";

export default class GsquareArenaZoneRace extends LightningElement {
  @api entries = [];
  @api currentZone;

  get views() {
    return (this.entries || []).map((e) => ({
      zone: e.zone,
      svConducted: Math.round(e.svConducted || 0),
      current: String(e.zone === this.currentZone)
    }));
  }
}
