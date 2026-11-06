import { describe, expect, test } from "bun:test";
import { pinQueue, takePin } from "../src/shared/pin.ts";
import { back, canBack, emptyNav, focusOn, jump, type Nav, next, orderQueue, readNav, skipCard } from "../src/shared/skip.ts";

// Ready cards in priority order, as main.tsx sorts them before the skip rule.
const cards = (...ids: string[]) => ids.map((id) => ({ id }));
const ready = cards("a", "b", "c");
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const front = (r: { id: string }[], nav: Nav) => orderQueue(r, nav.skipped)[0]?.id;

// Press Next n times; return the nav and the front card after each press. Mirrors main.tsx's onSkip.
function pressNext(n: number, r = ready, start: Nav = emptyNav()) {
  let nav = start;
  const fronts: string[] = [];
  for (let i = 0; i < n; i++) {
    nav = next(nav, orderQueue(r, nav.skipped));
    fronts.push(front(r, nav)!);
  }
  return { nav, fronts };
}
const pressBack = (nav: Nav, r = ready) => back(nav, r, front(r, nav));

describe("Next on the current card", () => {
  test("keeps cycling after every card has been skipped once", () => {
    // Before the fix: b,c,a,a,a,a,a. The skipped group was in priority order, so once every card was
    // skipped, re-skipping the front card left it in front and Next did nothing.
    expect(pressNext(7).fronts).toEqual(["b", "c", "a", "b", "c", "a", "b"]);
  });

  test("two cards: alternates forever", () => {
    expect(pressNext(4, cards("a", "b")).fronts).toEqual(["b", "a", "b", "a"]);
  });

  test("skips kept from before a reload still let Next move", () => {
    // sessionStorage held every card from an earlier pass, in any order.
    const start = readNav(null, JSON.stringify(["c", "a", "b"]));
    expect(pressNext(3, ready, start).fronts).toEqual(["a", "b", "c"]);
  });

  test("unskipped cards still come first, in priority order", () => {
    expect(ids(orderQueue(ready, ["a"]))).toEqual(["b", "c", "a"]);
    expect(ids(orderQueue(ready, ["b", "a"]))).toEqual(["c", "b", "a"]);
  });

  test("a card that arrives while everything is skipped goes in front", () => {
    expect(ids(orderQueue(cards("z", "a", "b", "c"), ["a", "b", "c"]))[0]).toBe("z");
  });

  test("skip ids for closed cards don't matter", () => {
    expect(ids(orderQueue(ready, ["gone", "a"]))).toEqual(["b", "c", "a"]);
  });

  test("the skip list and history stay bounded", () => {
    let nav = emptyNav();
    for (let i = 0; i < 260; i++) nav = next(nav, cards(`q${i}`));
    expect(nav.skipped.length).toBe(200);
    expect(nav.skipped.at(-1)).toBe("q259");
    expect(nav.history.length).toBe(30);
  });

  test("the cap drops closed cards first: a card skipped long ago and still open stays behind", () => {
    let nav = next(emptyNav(), ready); // a skipped
    for (let i = 0; i < 250; i++) nav = next(nav, [{ id: `q${i}` }, ...orderQueue(ready, nav.skipped)]); // q_i closes after
    expect(nav.skipped.length).toBe(200);
    expect(ids(orderQueue(ready, nav.skipped))).toEqual(["b", "c", "a"]);
  });

  test("no cards: Next does nothing", () => {
    const nav = emptyNav();
    expect(next(nav, [])).toBe(nav);
  });
});

describe("Back", () => {
  test("walks back card by card after a full pass", () => {
    // 5 cards, Next x6: fronts b,c,d,e,a,b. Before, the 2nd Back stuck on "a".
    const five = cards("a", "b", "c", "d", "e");
    let { nav } = pressNext(6, five);
    expect(front(five, nav)).toBe("b");
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { nav = pressBack(nav, five); seen.push(front(five, nav)!); }
    expect(seen).toEqual(["a", "e", "d", "c", "b", "a"]);
    expect(canBack(nav, five, front(five, nav))).toBe(false);
  });

  test("after a queue chip, Back returns to the card you left", () => {
    let nav = emptyNav();
    nav = jump(nav, orderQueue(ready, nav.skipped), "c");
    expect(front(ready, nav)).toBe("c");
    expect(new Set(nav.skipped).size).toBe(nav.skipped.length);
    expect(front(ready, pressBack(nav))).toBe("a");
  });

  test("a chip jump, even when every card was skipped", () => {
    const start: Nav = { skipped: ["a", "b", "c"], history: [] };
    const nav = jump(start, orderQueue(ready, start.skipped), "c");
    expect(front(ready, nav)).toBe("c");
    expect(new Set(nav.skipped).size).toBe(nav.skipped.length);
    expect(front(ready, next(nav, orderQueue(ready, nav.skipped)))).not.toBe("c");
  });

  test("after the deck's focus, Back returns to the card you were on", () => {
    let { nav } = pressNext(1); // front b
    nav = focusOn(nav, orderQueue(ready, nav.skipped), "a");
    expect(front(ready, nav)).toBe("a");
    expect(front(ready, pressBack(nav))).toBe("b");
  });

  test("passes over a step whose card has closed since", () => {
    let { nav } = pressNext(2); // fronts b, c
    const left = cards("a", "c"); // b was answered
    // Showing "c" now. The step that showed "b" would show "c" too, so Back passes over it to "a".
    nav = back(nav, left, front(left, nav));
    expect(front(left, nav)).toBe("a");
    expect(canBack(nav, left, "a")).toBe(false);
  });

  test("Back returns to a card that was pinned in front while you wrote on it", () => {
    // main.tsx runs Next on pinQueue(order, pin), which can differ from the plain order.
    let { nav } = pressNext(1); // a skipped, front b
    const pin = takePin(orderQueue(ready, nav.skipped))!; // writing on b
    const withZ = cards("z", "a", "b", "c"); // z arrives, higher priority
    const shown = pinQueue(orderQueue(withZ, nav.skipped), pin).queue;
    expect(ids(shown)).toEqual(["b", "z", "c", "a"]);
    nav = next(nav, shown); // navigate() drops the pin
    expect(front(withZ, nav)).toBe("z");
    nav = pressBack(nav, withZ);
    expect(front(withZ, nav)).toBe("b");
    // The step before that showed "a"; z arrived later, so it goes behind, not in front.
    nav = pressBack(nav, withZ);
    expect(front(withZ, nav)).toBe("a");
    expect(canBack(nav, withZ, "a")).toBe(false);
  });

  test("a card that arrives after a few Nexts doesn't block Back", () => {
    let { nav } = pressNext(2); // fronts b, c
    const withZ = cards("z", "a", "b", "c");
    expect(front(withZ, nav)).toBe("z"); // new arrivals go in front, as before
    // Back undoes moves, not arrivals: the last Next left "b", the one before left "a".
    const seen: string[] = [];
    for (let i = 0; i < 2; i++) { nav = pressBack(nav, withZ); seen.push(front(withZ, nav)!); }
    expect(seen).toEqual(["b", "a"]);
    expect(canBack(nav, withZ, "a")).toBe(false);
  });

  test("a skipped card that was snoozed stays skipped after Back", () => {
    let nav = next(emptyNav(), orderQueue(ready, [])); // a skipped, front b
    const noA = cards("b", "c"); // a snoozed (notBefore later)
    nav = next(nav, orderQueue(noA, nav.skipped)); // b skipped, front c
    nav = pressBack(nav, noA);
    expect(front(noA, nav)).toBe("b");
    // a comes back from snooze: still behind the cards you haven't skipped since.
    expect(front(ready, nav)).not.toBe("a");
    expect(ids(orderQueue(ready, nav.skipped)).indexOf("a")).toBeGreaterThan(0);
  });

  test("nothing to go back to: unchanged, and canBack is false", () => {
    const nav = emptyNav();
    expect(back(nav, ready, "a")).toBe(nav);
    expect(canBack(nav, ready, "a")).toBe(false);
  });
});

describe("readNav", () => {
  test("malformed storage reads as empty instead of breaking the view", () => {
    expect(readNav("null", "{}")).toEqual(emptyNav());
    expect(readNav("not json", "nope")).toEqual(emptyNav());
    expect(readNav(JSON.stringify({ skipped: ["a", 3, null], history: [["a"], "x"] }))).toEqual({ skipped: ["a"], history: [["a"]] });
    expect(readNav(JSON.stringify({ skipped: "x" }))).toEqual(emptyNav());
    expect(readNav(null, null)).toEqual(emptyNav());
  });

  test("the blob wins over the old skip list; the old list is read when there's no blob", () => {
    const nav = { skipped: ["b"], history: [["a", "b"]] };
    expect(readNav(JSON.stringify(nav), JSON.stringify(["c"]))).toEqual(nav);
    expect(readNav(null, JSON.stringify(["c"]))).toEqual({ skipped: ["c"], history: [] });
  });

  test("skipCard moves a card to the very back", () => {
    expect(skipCard(["a", "b"], "a")).toEqual(["b", "a"]);
  });
});
