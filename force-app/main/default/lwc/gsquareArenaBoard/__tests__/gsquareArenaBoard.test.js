import { createElement } from "lwc";
import Board from "c/gsquareArenaBoard";

const rows = Array.from({ length: 10 }, (_, i) => ({
  rank: i + 1,
  id: `p${i}`,
  name: `Caller ${i}`,
  initials: `C${i}`,
  photoUrl: i === 0 ? "/photo/0" : null,
  subLabel: "TL Arun",
  value: 10 - i,
  movement: i === 0 ? 2 : i === 1 ? -1 : null
}));

function mount(props) {
  const el = createElement("c-gsquare-arena-board", { is: Board });
  Object.assign(el, props);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  while (document.body.firstChild)
    document.body.removeChild(document.body.firstChild);
});

describe("c-gsquare-arena-board", () => {
  it("splits a top board into two columns of five", () => {
    const el = mount({ rows, variant: "top", unit: "" });
    const cols = el.shadowRoot.querySelectorAll(".col");
    expect(cols).toHaveLength(2);
    expect(cols[0].querySelectorAll(".row")).toHaveLength(5);
    expect(cols[1].querySelectorAll(".row")).toHaveLength(5);
  });

  it("uses a photo only when photoUrl exists, initials otherwise", () => {
    const el = mount({ rows, variant: "top" });
    const r = el.shadowRoot.querySelectorAll(".row");
    expect(r[0].querySelector("img").getAttribute("src")).toBe("/photo/0");
    expect(r[1].querySelector("img")).toBeNull();
    expect(r[1].querySelector(".av").textContent).toBe("C1");
  });

  it("shows rank movement arrows", () => {
    const el = mount({ rows, variant: "top" });
    const mv = el.shadowRoot.querySelectorAll(".mv");
    expect(mv[0].textContent).toBe("\u25B22");
    expect(mv[1].textContent).toBe("\u25BC1");
    expect(mv[2].textContent).toBe("");
  });

  it("bottom board is one column and highlights zeros, with unit suffix", () => {
    const el = mount({
      rows: [{ ...rows[0], value: 0, movement: null }],
      variant: "bottom",
      unit: "m"
    });
    expect(el.shadowRoot.querySelectorAll(".col")).toHaveLength(1);
    const v = el.shadowRoot.querySelector(".val");
    expect(v.textContent).toBe("0m");
    expect(v.classList.contains("zero")).toBe(true);
  });
});
