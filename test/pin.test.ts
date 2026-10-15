import { describe, expect, test } from "bun:test";
import { pinQueue, takePin } from "../src/shared/pin.ts";

const q = (id: string, priority: number) => ({ id, priority });
const sort = (xs: { id: string; priority: number }[]) => [...xs].sort((a, b) => b.priority - a.priority);

describe("pinQueue", () => {
  test("no pin: queue unchanged", () => {
    const queue = sort([q("a", 1), q("b", 5)]);
    expect(pinQueue(queue).queue.map((x) => x.id)).toEqual(["b", "a"]);
    expect(pinQueue(queue).fresh).toBe(0);
  });

  test("a higher-priority arrival doesn't take the front while pinned", () => {
    const before = sort([q("q1", 3), q("q0", 1)]);
    const pin = takePin(before)!;
    expect(pin.id).toBe("q1");
    const after = sort([...before, q("q2", 9)]);
    const shown = pinQueue(after, pin);
    expect(shown.queue.map((x) => x.id)).toEqual(["q1", "q2", "q0"]);
    expect(shown.fresh).toBe(1);
  });

  test("pinned card closed elsewhere: falls back to normal order", () => {
    const pin = takePin([q("q1", 3), q("q0", 1)])!;
    const shown = pinQueue(sort([q("q0", 1), q("q2", 9)]), pin);
    expect(shown.queue.map((x) => x.id)).toEqual(["q2", "q0"]);
    expect(shown.fresh).toBe(1);
  });

  test("empty queue: no pin", () => {
    expect(takePin([])).toBeUndefined();
  });
});
