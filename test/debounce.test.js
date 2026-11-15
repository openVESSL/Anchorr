import assert from "node:assert/strict";
import test from "node:test";

import { debounce } from "../utils/debounce.js";

test("runs once after the last call, with its arguments; flush and cancel", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const fn = debounce((...args) => calls.push(args), 100);

  fn(1);
  t.mock.timers.tick(60);
  fn(2);
  t.mock.timers.tick(60);
  assert.deepEqual(calls, [], "the second call restarts the wait");
  t.mock.timers.tick(40);
  assert.deepEqual(calls, [[2]]);

  fn(3);
  fn.flush();
  assert.deepEqual(calls, [[2], [3]], "flush runs the pending call now");
  t.mock.timers.tick(200);
  assert.equal(calls.length, 2, "and only once");

  fn(4);
  fn.cancel();
  t.mock.timers.tick(200);
  assert.equal(calls.length, 2);
  assert.equal(fn.flush(), undefined, "nothing pending");
});
