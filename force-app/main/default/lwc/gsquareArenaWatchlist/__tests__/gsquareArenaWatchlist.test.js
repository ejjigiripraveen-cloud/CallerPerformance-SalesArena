import { createElement } from "lwc";
import Watchlist from "c/gsquareArenaWatchlist";

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-watchlist", () => {
  it("lists reasons and marks critical rows", () => {
    const el = createElement("c-gsquare-arena-watchlist", { is: Watchlist });
    el.rows = [
      {
        id: "a",
        name: "Zero B",
        initials: "ZB",
        photoUrl: null,
        severity: "critical",
        zeros: 3,
        reasons: [
          { metric: "Allocation", value: 0, unit: "" },
          { metric: "Talktime", value: 0, unit: "m" }
        ]
      },
      {
        id: "b",
        name: "Weak C",
        initials: "WC",
        photoUrl: null,
        severity: "important",
        zeros: 0,
        reasons: [{ metric: "Allocation", value: 1, unit: "" }]
      }
    ];
    document.body.appendChild(el);
    const r = el.shadowRoot.querySelectorAll(".wrow");
    expect(r).toHaveLength(2);
    expect(r[0].classList.contains("critical")).toBe(true);
    expect(r[0].querySelector(".why").textContent).toBe(
      "Allocation 0, Talktime 0m"
    );
    expect(r[1].classList.contains("critical")).toBe(false);
  });

  it("shows an all-clear message when empty", () => {
    const el = createElement("c-gsquare-arena-watchlist", { is: Watchlist });
    el.rows = [];
    document.body.appendChild(el);
    expect(el.shadowRoot.querySelector(".empty").textContent).toBe(
      "Nobody on the watchlist right now"
    );
  });
});
