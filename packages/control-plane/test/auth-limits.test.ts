import { expect, it } from "vitest";
import { AttemptCounter } from "../src/http/auth-limits.js";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

it("计满才挡，回剩下的毫秒数，窗口过了自动放开", () => {
  const time = clock();
  const counter = new AttemptCounter(2, 1000, 100, time.now);

  counter.hit("a@baize.dev");
  expect(counter.blockedFor("a@baize.dev")).toBeNull();
  counter.hit("a@baize.dev");
  time.advance(300);
  expect(counter.blockedFor("a@baize.dev")).toBe(700);

  time.advance(700);
  expect(counter.blockedFor("a@baize.dev"), "窗口到期就放开").toBeNull();
  counter.hit("a@baize.dev");
  expect(counter.blockedFor("a@baize.dev"), "到期后重新起一个窗口").toBeNull();
});

it("退回一次和清零都能把挡住的键放开", () => {
  const counter = new AttemptCounter(1, 1000);
  counter.hit("a");
  counter.unhit("a");
  expect(counter.blockedFor("a")).toBeNull();
  counter.hit("b");
  counter.clear("b");
  expect(counter.blockedFor("b")).toBeNull();
});

it("键数到上限时先丢过期的，都没过期就丢最早的", () => {
  const time = clock();
  const counter = new AttemptCounter(1, 1000, 2, time.now);

  counter.hit("old");
  time.advance(1000);
  counter.hit("a");
  counter.hit("b");
  expect(counter.blockedFor("a"), "丢的是过期的 old，a 还在").not.toBeNull();
  expect(counter.blockedFor("b")).not.toBeNull();

  counter.hit("c");
  expect(counter.blockedFor("a"), "都没过期时丢最早建的 a").toBeNull();
  expect(counter.blockedFor("b")).not.toBeNull();
  expect(counter.blockedFor("c")).not.toBeNull();
});
