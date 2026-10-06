import { createElement } from "lwc";
import Hero from "c/gsquareArenaHero";

const tiles = [
  {
    key: "allocation",
    label: "Allocation today",
    today: 64,
    pace: { tone: "good", text: "+6 vs typical 58" },
    mtd: 1412,
    mtdState: { tone: "good", text: "+8% vs Sep" }
  },
  {
    key: "svConducted",
    label: "SV conducted today",
    today: 18,
    pace: { tone: "warning", text: "4 behind typical 22" },
    mtd: 412,
    mtdState: { tone: "warning", text: "\u22123% vs Sep" }
  },
  {
    key: "booking",
    label: "Booking today",
    today: 2,
    pace: { tone: "neutral", text: "On pace, typical 2" },
    mtd: 11,
    mtdState: { tone: "good", text: "+2 vs Sep" }
  }
];

function mount(props) {
  const el = createElement("c-gsquare-arena-hero", { is: Hero });
  Object.assign(el, props);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-hero", () => {
  it("renders three tiles with tone attributes and MTD lines", () => {
    const el = mount({
      zoneName: "Zone 1",
      clockText: "2:14",
      ampm: "pm",
      dateText: "Tue 6 Oct",
      tiles,
      updatedText: "Updated just now",
      staleState: "fresh"
    });
    const t = el.shadowRoot.querySelectorAll(".tile");
    expect(t).toHaveLength(3);
    expect([...t].map((x) => x.dataset.tone)).toEqual([
      "good",
      "warning",
      "neutral"
    ]);
    expect(t[0].querySelector(".today").textContent).toBe("64");
    expect(t[0].querySelector(".mtd .v").textContent).toBe("1,412");
    expect(t[1].querySelector(".mtd .d").textContent).toBe("\u22123% vs Sep");
  });

  it("marks the updated line red when data is stale", () => {
    const el = mount({
      tiles: [],
      updatedText: "Data paused, reconnecting",
      staleState: "red"
    });
    const u = el.shadowRoot.querySelector('[data-id="updated"]');
    expect(u.classList.contains("red")).toBe(true);
    expect(u.textContent).toBe("Data paused, reconnecting");
  });
});
