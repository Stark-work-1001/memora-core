/**
 * One policy for "the first frame, and the 最佳视角 button, across three renderers".
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The three brain types are three different renderers with three different ideas of what a camera
 * pose is, but the user asked for one consistent behaviour: the view should rotate itself to the
 * angle the graph reads best at, and it must be possible to ask for that angle again on demand.
 *
 *   dictionary / matt (dictionary-graph): {azimuth, polar, distance} -- and the choice is
 *       focus.ts's bestAngles() + frameCluster(), which score a 24 x 7 ring by how much of the
 *       stage the graph can fill. That is already the algorithm; this module only decides WHO
 *       calls it and WHEN.
 *   outline (original-dev): a quaternion, and the host already ships rig.bestOrientation()
 *       (20 azimuths x 7 elevations, scored by screen spread) reached through `app.overview()`
 *       -> frameAll(true) -> rig.frame(..., pickOrientation). Again: do not reimplement it.
 *
 * So what is shared here is not the algorithm but the *contract*:
 *
 *   - run once, after the layout has settled, 650-950 ms after the view is up (positions are
 *     still arriving asynchronously: the projection is fetched after start());
 *   - run only once per view; a reader who turns the camera keeps it;
 *   - never move anything under prefers-reduced-motion unless asked explicitly (then jump
 *     instantly rather than fly);
 *   - expose the same call for the toolbar button and for the acceptance run.
 *
 * WHAT IS *NOT* SHARED
 * --------------------
 * The mat/t dictionary path needs the graph to be non-empty before bestAngles means anything
 * (with fewer than two spheres it returns the current pose), and the outline path needs the
 * physics layout to have stopped. Those are the two "settled" predicates, and they stay with the
 * views; this module owns the timing and the once-only latch.
 */

/** What a view reports after an attempt, for the toolbar, the tests and the acceptance run. */
export interface BestViewOutcome {
  /** The pose the view sent the camera to, in its own convention. */
  azimuth?: number;
  polar?: number;
  distance?: number;
  /** outline only: the quaternion the rig was sent to. */
  quaternion?: [number, number, number, number];
  /** Which path produced it: the selector's own angles, or the vendor's bestOrientation. */
  source: 'focus' | 'vendor';
  /** False when the graph had nothing to frame (empty, or a single node). */
  moved: boolean;
}

/** A view that can answer "put the camera where this graph reads best". */
export interface BestViewHost {
  /**
   * Attempt the move. Returns null when there is nothing to frame yet, so the selector can keep
   * waiting instead of latching a failed attempt as "done".
   */
  apply(ms: number): BestViewOutcome | null;
  /** True once the layout has settled enough for the answer to be meaningful. */
  settled(): boolean;
}

/** Everything the selector exposes, and the whole of what the acceptance run reads. */
export interface BestViewSeam {
  /** The last outcome, or null before the first successful move. */
  readonly last: BestViewOutcome | null;
  /** How many times the camera was actually moved. */
  readonly attempts: number;
  /** Run it now (the toolbar button). Returns the outcome, or null when nothing could be framed. */
  run(ms?: number): BestViewOutcome | null;
  /** Stop the automatic first run and the watcher. */
  dispose(): void;
}

export interface BestViewOptions {
  /**
   * Delay after the view reports "settled" before the automatic run.
   *
   * 650 ms is the same order as the existing first-frame fit (graph-look waits 900 ms from start;
   * the outline waits for the engine to stop). It is not a magic number: the point is that the
   * auto-run must land AFTER whatever the view already does on its first frame, or two camera
   * animations would race and the reader would see the pose snap back.
   */
  delayMs?: number;
  /** Give up waiting for `settled()` after this long. Defaults to 12 s. */
  timeoutMs?: number;
  /** Respect prefers-reduced-motion: no animation, but still rotate there. Defaults to true. */
  respectMotion?: boolean;
  /** Duration of the animated move. Defaults to 650 ms. */
  durationMs?: number;
  /** Injected for tests: the clock and the frame scheduler. */
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Injected for tests: the motion preference. */
  reducedMotion?: () => boolean;
}

/**
 * Wire the automatic first run and the on-demand run for one view.
 *
 * The loop polls `settled()` (the two hosts announce "settled" very differently: one has an
 * asynchronous fetch, the other a physics engine that stops on its own), then waits `delayMs`,
 * then moves once. A failed `apply` (nothing to frame) is NOT latched: it is retried until the
 * timeout, because "the graph is still empty" is a normal state one network round-trip long.
 */
export function installBestView(host: BestViewHost, options: BestViewOptions = {}): BestViewSeam {
  const delayMs = options.delayMs ?? 650;
  const timeoutMs = options.timeoutMs ?? 12000;
  const durationMs = options.durationMs ?? 650;
  const respectMotion = options.respectMotion !== false;
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const prefersReduced = options.reducedMotion
    ?? (() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);

  const state: { last: BestViewOutcome | null; attempts: number; disposed: boolean; automatic: boolean } = {
    last: null, attempts: 0, disposed: false, automatic: true,
  };
  const started = now();
  let handle: unknown = null;
  let armedAt = -1;

  /** The duration to hand the host: reduced motion means "get there now", not "do not go". */
  const duration = (explicit?: number): number => {
    if (explicit !== undefined) return respectMotion && prefersReduced() ? 0 : explicit;
    return respectMotion && prefersReduced() ? 0 : durationMs;
  };

  const run = (ms?: number): BestViewOutcome | null => {
    if (state.disposed) return null;
    const outcome = host.apply(duration(ms));
    if (!outcome) return null;
    state.last = outcome;
    state.attempts += 1;
    return outcome;
  };

  const finishAutomatic = (): void => { state.automatic = false; handle = null; };

  const wait = (): void => {
    if (state.disposed || !state.automatic) return;
    handle = null;
    // A view that never settles (an empty project, a failed fetch) must not poll forever.
    if (now() - started > timeoutMs) { finishAutomatic(); return; }
    if (!host.settled()) { handle = setTimer(wait, 120); return; }
    // Settled: wait one beat so the view's own first-frame fit has finished moving the camera.
    if (armedAt < 0) { armedAt = now(); handle = setTimer(wait, delayMs); return; }
    const outcome = run();
    if (!outcome) {
      // Still nothing to frame (empty graph): reset the delay so the retry is not a busy loop, and
      // keep waiting until the timeout.
      armedAt = now();
      handle = setTimer(wait, delayMs);
      return;
    }
    finishAutomatic();
  };

  handle = setTimer(wait, 0);

  return {
    get last() { return state.last; },
    get attempts() { return state.attempts; },
    run,
    dispose(): void {
      state.disposed = true;
      state.automatic = false;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}

/**
 * The toolbar contract, in one place.
 *
 * memory.html/memory.js are the Lead's files, so the button is not built there. The view builds it
 * inside its own chrome (graph-workbench.ts already owns the brain toolbar), which keeps the three
 * views identical without a second switch statement in the workbench.
 */
export const BEST_VIEW_LABEL = '最佳视角';
