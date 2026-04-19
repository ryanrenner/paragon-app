'use strict';

/**
 * queue.js
 *
 * One-at-a-time promise queue. All work that talks to Paragon goes through
 * this so two incoming HTTP requests can't both launch scrapes at once.
 *
 * Per docs/01-decisions.md: single user, no parallelism needed, and Paragon
 * itself only tolerates one active browser session per MLS account.
 */

class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  /**
   * Enqueue an async task. Returns a promise resolving to the task's result.
   */
  run(taskFn) {
    this.pending++;
    const next = this.tail.then(() => taskFn()).finally(() => {
      this.pending--;
    });
    // `next` might reject — don't let that poison the chain for future tasks.
    this.tail = next.catch(() => {});
    return next;
  }
}

const singleton = new SerialQueue();

module.exports = {
  SerialQueue,
  getQueue: () => singleton,
};
