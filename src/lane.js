// -----------------------------------------------------------------------------
// One move at a time: a move waits for the previous one to be written and
// answered (or refused) before its own reads. A STOP never takes the lane
// (src/app.js): it cancels the moves waiting in it.
// -----------------------------------------------------------------------------

export class Lane {
  constructor() {
    this.tail = Promise.resolve();
  }

  /** Runs `task` after the tasks given before it; resolves or rejects with it. */
  run(task) {
    const run = this.tail.then(task);
    this.tail = run.catch(() => {});
    return run;
  }
}
