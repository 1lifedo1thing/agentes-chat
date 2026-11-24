import { afterEach, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, render } from "@testing-library/react";
import { useNow } from "../src";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "hidden");
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

test("a clock doesn't move while the page is hidden, and reads the time again once it shows", async () => {
  let draws = 0;
  function Clock() {
    useNow(10);
    draws++;
    return null;
  }
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  render(<Clock />);
  const first = draws;
  await wait(80);
  expect(draws).toBe(first);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(draws).toBe(first + 1);
  await wait(80);
  expect(draws).toBeGreaterThan(first + 2);
});
