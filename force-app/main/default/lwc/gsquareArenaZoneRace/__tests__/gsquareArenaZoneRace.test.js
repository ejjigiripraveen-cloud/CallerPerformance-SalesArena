import { createElement } from "lwc";
import ZoneRace from "c/gsquareArenaZoneRace";

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-zone-race", () => {
  it("marks the current zone", () => {
    const el = createElement("c-gsquare-arena-zone-race", { is: ZoneRace });
    el.entries = [
      { zone: "Zone 3", svConducted: 21 },
      { zone: "Zone 1", svConducted: 18 }
    ];
    el.currentZone = "Zone 1";
    document.body.appendChild(el);
    const z = el.shadowRoot.querySelectorAll(".z");
    expect(z).toHaveLength(2);
    expect(z[0].dataset.current).toBe("false");
    expect(z[1].dataset.current).toBe("true");
    expect(z[1].querySelector("b").textContent).toBe("18");
  });
});
