// -----------------------------------------------------------------------------
// The read cadence with timers that fire by themselves, 1 ms BEFORE their due
// time (as Node's cached timer clock may do), on a monotonic clock that moves
// at every read of it: a refresh at every interval, never put off by the 1 s
// floor. Against the fake MotionMount on 127.0.0.1.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { MotionMountApp } from '../src/app.js';
import { SECOND, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { fakeMount } from './helpers/fakeMount.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A virtual monotonic clock (moves a little at every read) and timers that fire early. */
function virtualTime({ early = 1 } = {}) {
  let time = 1_000_000;
  const pending = [];
  let seq = 0;
  return {
    now: () => {
      time += 0.01;
      return time;
    },
    timers: {
      setTimeout: (fn, ms) => {
        seq += 1;
        pending.push({ id: seq, fn, ms, due: time + ms });
        return seq;
      },
      clearTimeout: (handle) => {
        const at = pending.findIndex((p) => p.id === handle);
        if (at !== -1) pending.splice(at, 1);
      },
      setInterval: () => 0,
      clearInterval: () => {},
    },
    /** Fires the earliest timer, the clock set `early` ms before its due time. */
    next() {
      pending.sort((a, b) => a.due - b.due);
      const timer = pending.shift();
      if (!timer) return undefined;
      time = Math.max(time, timer.due - early);
      timer.fn();
      return timer;
    },
  };
}

test('a refresh at every interval when the timers fire 1 ms early (no 1 s catch-up)', async (t) => {
  const mount = await fakeMount();
  t.after(() => mount.close());
  const clock = virtualTime({ early: 1 });
  const gladys = createFakeGladys({
    selector: 'motionmount',
    config: { host: mount.host, poll_interval: 30 },
  });
  const app = new MotionMountApp({
    gladys,
    logger: quiet,
    store: memoryStore(),
    now: clock.now,
    timers: clock.timers,
    timings: TIMINGS,
  });
  t.after(() => app.stop());
  registerHandlers(gladys, app, quiet);
  await gladys.connect();
  const settle = async () => {
    // The tick runs on real sockets: wait for it to finish.
    for (let i = 0; i < 200 && (app.running || app.opening); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const refreshes = [];
  const fired = [];
  for (let i = 0; i < 8 && refreshes.length < 5; i += 1) {
    const before = app.refreshAt;
    const timer = clock.next();
    assert.ok(timer, 'a timer is armed');
    fired.push(timer.ms);
    await settle();
    if (app.refreshAt !== before) {
      refreshes.push(app.refreshAt);
    }
  }
  assert.equal(refreshes.length, 5, `fired: ${fired.join(', ')}`);
  for (let i = 1; i < refreshes.length; i += 1) {
    const gap = refreshes[i] - refreshes[i - 1];
    assert.ok(Math.abs(gap - 30 * SECOND) < 50, `gap ${gap} ms`);
  }
  assert.ok(!fired.slice(1).includes(SECOND), `a 1 s catch-up timer fired: ${fired.join(', ')}`);
});
