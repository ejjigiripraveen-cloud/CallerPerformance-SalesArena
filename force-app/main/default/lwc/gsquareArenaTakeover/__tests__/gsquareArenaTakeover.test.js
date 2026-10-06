import { createElement } from "lwc";
import Takeover from "c/gsquareArenaTakeover";

const base = {
  callerName: "Priya R",
  initials: "PR",
  photoUrl: null,
  tlName: "Sushma",
  zone: "Zone 1",
  project: "G Square Palm Springs",
  countText: "Booking 3 today in Zone 1, 12 this month"
};

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-takeover", () => {
  it("shows caller, team and project", () => {
    const el = createElement("c-gsquare-arena-takeover", { is: Takeover });
    el.booking = base;
    document.body.appendChild(el);
    expect(el.shadowRoot.querySelector(".who").textContent).toBe("Priya R");
    expect(el.shadowRoot.querySelector(".meta").textContent).toBe(
      "Team Sushma, Zone 1"
    );
    expect(el.shadowRoot.querySelector(".project").textContent).toBe(
      "G Square Palm Springs"
    );
    expect(el.shadowRoot.querySelector(".big").textContent).toBe("PR");
  });

  it("hides the project line when blank and uses the photo when present", () => {
    const el = createElement("c-gsquare-arena-takeover", { is: Takeover });
    el.booking = { ...base, project: "", photoUrl: "/p.png", tlName: null };
    document.body.appendChild(el);
    expect(el.shadowRoot.querySelector(".project")).toBeNull();
    expect(el.shadowRoot.querySelector("img").getAttribute("src")).toBe(
      "/p.png"
    );
    expect(el.shadowRoot.querySelector(".meta").textContent).toBe("Zone 1");
  });
});
