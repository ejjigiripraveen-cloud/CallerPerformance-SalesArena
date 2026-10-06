import { createElement } from "lwc";
import TeamTable from "c/gsquareArenaTeamTable";

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-team-table", () => {
  it("renders labels, sums and pace", () => {
    const el = createElement("c-gsquare-arena-team-table", { is: TeamTable });
    el.rows = [
      {
        id: "T1",
        name: "Arun",
        label: "TL Arun \u00b7 6 of 11 callers",
        allocation: 6,
        svScheduled: 4,
        svConducted: 3,
        booking: 1,
        talktime: 300,
        pace: { tone: "warning", text: "2 behind typical 5" }
      },
      {
        id: "T2",
        name: "Sushma",
        label: "TL Sushma",
        allocation: 2,
        svScheduled: 1,
        svConducted: 1,
        booking: 0,
        talktime: 90,
        pace: null
      }
    ];
    el.showPace = true;
    document.body.appendChild(el);
    const trs = el.shadowRoot.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(2);
    expect(trs[0].querySelector(".lbl").textContent).toBe(
      "TL Arun \u00b7 6 of 11 callers"
    );
    expect(trs[0].querySelector(".pace").textContent).toBe(
      "2 behind typical 5"
    );
    expect(trs[0].querySelector(".pace").classList.contains("warning")).toBe(
      true
    );
    expect(trs[0].querySelector('[data-k="talktime"]').textContent).toBe(
      "300m"
    );
  });

  it("hides the pace column for leaders", () => {
    const el = createElement("c-gsquare-arena-team-table", { is: TeamTable });
    el.rows = [
      {
        id: "M1",
        name: "Ravi",
        label: "Manager Ravi",
        allocation: 1,
        svScheduled: 1,
        svConducted: 1,
        booking: 0,
        talktime: 10,
        pace: null
      }
    ];
    el.showPace = false;
    document.body.appendChild(el);
    expect(el.shadowRoot.querySelector(".pace")).toBeNull();
  });
});
