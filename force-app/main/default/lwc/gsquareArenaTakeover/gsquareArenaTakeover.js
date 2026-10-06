import { LightningElement, api } from "lwc";

export default class GsquareArenaTakeover extends LightningElement {
  @api booking = {};

  get meta() {
    const b = this.booking || {};
    return [b.tlName ? `Team ${b.tlName}` : null, b.zone]
      .filter(Boolean)
      .join(", ");
  }
}
