/// <reference types="bun" />
import { expect, test } from "bun:test";
import { split } from "./index";

const total = (rows: readonly (readonly [string, number])[]) => rows.reduce((a, [, v]) => a + v, 0);

test("even split keeps the leftover đồng and sums to the amount", () => {
  expect(split(100, ["a", "b", "c"])).toEqual([["a", 34], ["b", 33], ["c", 33]]);
  expect(total(split(101, ["a", "b", "c"]))).toBe(101);
});

test("weights scale the share and the remainder goes to the heaviest", () => {
  expect(split(100_000, ["a", "b", "c"], { a: 1, b: 2, c: 1 })).toEqual([["a", 25_000], ["b", 50_000], ["c", 25_000]]);
  expect(split(100, ["a", "b", "c"], { a: 3, b: 1, c: 1 })).toEqual([["a", 60], ["b", 20], ["c", 20]]);
  const odd = split(10, ["a", "b"], { a: 2, b: 1 });
  expect(total(odd)).toBe(10);
  expect(odd[0][1]).toBeGreaterThan(odd[1][1]);
});

test("a missing weight counts as 1, and shares always sum to the amount", () => {
  expect(split(90, ["a", "b", "c"], { b: 2 })).toEqual([["a", 22], ["b", 46], ["c", 22]]);
  for (const amount of [1, 7, 13, 1000]) {
    for (const weights of [undefined, { a: 1.5, b: 2.25, c: 0.75 }]) {
      expect(total(split(amount, ["a", "b", "c"], weights))).toBe(amount);
    }
  }
});
