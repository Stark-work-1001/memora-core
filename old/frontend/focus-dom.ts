/**
 * The glue each 3D brain view uses to apply a framing decision, kept out of the
 * two vendor host classes (which are third-party and must stay unedited).
 *
 * Two things live here that both views need and neither vendor file provides:
 * - `stageInsets`: how much of the stage an open panel covers, so the camera
 *   fits the *visible* part of the window instead of centring the cluster under
 *   the panel.
 * - `reducedMotion`: the motion preference every camera move respects.
 *
 * It is separate from `focus.ts` because that one is pure maths and is unit
 * tested in node; this one reads computed layout.
 */
import type { FrameViewport } from './focus';

/** The parts of a copied host this glue is allowed to look at. */
export interface FocusHost {
  readonly stage: HTMLElement;
  readonly panel?: HTMLElement | null;
  readonly inspector?: HTMLElement | null;
}

/** A panel that actually covers part of the stage, as a rectangle. */
interface Cover { left: number; top: number; right: number; bottom: number; width: number; height: number }

function visibleCovers(stage: DOMRect, panels: Array<HTMLElement | null | undefined>): Cover[] {
  const covers: Cover[] = [];
  for (const panel of panels) {
    if (!panel) continue;
    const style = getComputedStyle(panel);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const box = panel.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const left = Math.max(stage.left, box.left), right = Math.min(stage.right, box.right);
    const top = Math.max(stage.top, box.top), bottom = Math.min(stage.bottom, box.bottom);
    if (right - left <= 1 || bottom - top <= 1) continue;
    covers.push({ left: left - stage.left, top: top - stage.top, right: right - stage.left,
      bottom: bottom - stage.top, width: right - left, height: bottom - top });
  }
  return covers;
}

/**
 * Stage viewport plus the band an open panel hides.
 *
 * A panel can be excluded as a band on any side it touches, and the sides are
 * not equivalent: the hierarchy view's inspector is a tall block in the corner
 * of a narrow window, where taking it off the right leaves a 178px sliver while
 * taking it off the bottom leaves a full-width band. Choosing the exclusion
 * that keeps the most area is what stops a portrait window from fitting the
 * cluster into a postage stamp.
 *
 * Each panel is only counted once, and only when it actually overlaps the
 * stage: a panel that sits *beside* the stage has already narrowed it by the
 * time this runs, and subtracting it a second time would push the cluster off
 * to one side.
 */
export function stageInsets(host: FocusHost): FrameViewport {
  const stage = host.stage.getBoundingClientRect();
  const width = Math.max(1, Math.round(stage.width));
  const height = Math.max(1, Math.round(stage.height));
  const viewport: FrameViewport = { width, height, insetTop: 0, insetRight: 0, insetBottom: 0, insetLeft: 0 };
  const usable = () => Math.max(1, width - (viewport.insetLeft ?? 0) - (viewport.insetRight ?? 0))
    * Math.max(1, height - (viewport.insetTop ?? 0) - (viewport.insetBottom ?? 0));

  for (const cover of visibleCovers(stage, [host.panel, host.inspector])) {
    // Four candidate bands: the panel taken off each side it touches, measured
    // to the far edge of the pixel range it occupies.
    const options: Array<[keyof FrameViewport, number]> = [
      ['insetRight', Math.round(stage.width - cover.left)],
      ['insetLeft', Math.round(cover.right)],
      ['insetBottom', Math.round(stage.height - cover.top)],
      ['insetTop', Math.round(cover.bottom)],
    ];
    let bestSide: keyof FrameViewport = 'insetRight';
    let bestArea = -1;
    for (const [side, value] of options) {
      const attempt: FrameViewport = { ...viewport, [side]: Math.max(Number(viewport[side] ?? 0), value) };
      const area = Math.max(1, width - (attempt.insetLeft ?? 0) - (attempt.insetRight ?? 0))
        * Math.max(1, height - (attempt.insetTop ?? 0) - (attempt.insetBottom ?? 0));
      if (area > bestArea) { bestArea = area; bestSide = side; }
      void attempt;
    }
    const chosen = options.find(([side]) => side === bestSide);
    if (!chosen) continue;
    // Keep at least 45% of each axis: a panel must never squeeze the fit so far
    // that the cluster becomes a dot, which is the failure this is fixing.
    const limitX = Math.round(width * 0.55), limitY = Math.round(height * 0.55);
    const value = bestSide === 'insetLeft' || bestSide === 'insetRight'
      ? Math.min(chosen[1], limitX) : Math.min(chosen[1], limitY);
    const current = Number(viewport[bestSide] ?? 0);
    if (value > current && usable() > 1) viewport[bestSide] = value;
  }
  return viewport;
}

export function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
