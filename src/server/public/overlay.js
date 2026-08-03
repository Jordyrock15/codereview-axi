/**
 * Timing for the diff-update overlay. A show-delay so an instant local
 * re-render never flashes it, and a minimum visible duration once shown so a
 * refresh that just clears the delay does not flicker straight back off.
 */
export const OVERLAY_SHOW_DELAY_MS = 150;
export const OVERLAY_MIN_VISIBLE_MS = 200;

/**
 * Timing for the `refreshed` cause: the agent changed the code, so the
 * overlay is change feedback, not a slow-work spinner, and must always be
 * seen. No show-delay, and a longer minimum so it reads as a deliberate
 * signal rather than a flicker.
 */
export const OVERLAY_REFRESHED_SHOW_DELAY_MS = 0;
export const OVERLAY_REFRESHED_MIN_VISIBLE_MS = 300;

/**
 * Whether the overlay is still worth revealing once the show-delay timer
 * fires: not if the work it is covering already finished in the meantime.
 * @param {{elapsedMs: number, finished: boolean, showDelayMs?: number}} args
 * @returns {boolean}
 */
export const overlayVisible = ({ elapsedMs, finished, showDelayMs = OVERLAY_SHOW_DELAY_MS }) => (
  !finished && elapsedMs >= showDelayMs
);

/**
 * How much longer, in ms, an overlay that has been visible for `visibleForMs`
 * must stay up before it may hide, so it is never visible for less than
 * `minVisibleMs` in total.
 * @param {number} visibleForMs
 * @param {number} [minVisibleMs]
 * @returns {number}
 */
export const remainingVisibleMs = (visibleForMs, minVisibleMs = OVERLAY_MIN_VISIBLE_MS) => (
  Math.max(0, minVisibleMs - visibleForMs)
);
