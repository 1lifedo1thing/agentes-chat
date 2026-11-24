import { afterEach, expect, test } from "bun:test";
import { enableCaches, TtlCache } from "../src";

afterEach(() => enableCaches(false));

/** A value that arrives when `release` is called, however many loads wait on it. */
function later<V>() {
  let release!: (value: V) => void;
  const value = new Promise<V>((resolve) => {
    release = resolve;
  });
  return { value, release };
}

test("misses while a load runs share it: one read for all of them", async () => {
  enableCaches();
  const cache = new TtlCache<string>(60_000);
  const row = later<string>();
  let loads = 0;
  const load = () => {
    loads++;
    return row.value;
  };
  const waiting = [cache.getOrLoad("org1:a", load), cache.getOrLoad("org1:a", load), cache.getOrLoad("org1:a", load)];
  row.release("v1");
  expect(await Promise.all(waiting)).toEqual(["v1", "v1", "v1"]);
  expect(loads).toBe(1);
  expect(cache.get("org1:a")).toBe("v1");
});

test("a miss after an invalidation reads again: the load under way may predate the write", async () => {
  enableCaches();
  const cache = new TtlCache<string>(60_000);
  const old = later<string>();
  const first = cache.getOrLoad("org1:a", () => old.value);
  cache.delete("org1:a");
  expect(await cache.getOrLoad("org1:a", async () => "after the write")).toBe("after the write");
  old.release("before the write");
  expect(await first).toBe("before the write");
  expect(cache.get("org1:a")).toBe("after the write");
});

test("a value `keep` refuses isn't shared: whoever waited on it reads again", async () => {
  enableCaches();
  const cache = new TtlCache<string | null>(60_000);
  const absent = later<string | null>();
  const keep = (value: string | null) => value !== null;
  const first = cache.getOrLoad("org1:bia", () => absent.value, keep);
  const second = cache.getOrLoad("org1:bia", async () => "member", keep);
  absent.release(null);
  expect(await first).toBeNull();
  expect(await second).toBe("member");
});
