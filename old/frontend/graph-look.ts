/**
 * First-party look and legibility settings for the copied 3D graph.
 *
 * Two problems the vendored renderer cannot solve for us, because both are
 * properties of the copied defaults rather than bugs:
 *
 *  1. The dictionary's resting edge opacity is tuned for a 543-term reference
 *     dictionary on a dark Obsidian theme. On Memora's light background, at a
 *     dozen terms, 0.22 draws links that are effectively invisible -- a user
 *     looking at the demo graph asked "where are the connections?".
 *  2. Its label layer draws every name at once and has no collision test, so in
 *     a dense first frame several labels print over each other. The outline
 *     renderer has an occupancy grid; the dictionary one does not.
 *
 * Both are addressed from the OUTSIDE: this module only reads the host's public
 * state (settings, scene, camera) and writes through the same seams the host's
 * own toolbar uses. `vendor/**` stays unedited.
 */
import { Vector3 } from 'three';
import { bestAngles, frameCluster, type FocusSphere } from './focus';

/** Host shape this module needs. Extension, not replacement: same instance the shell holds. */
export interface LookHost {
  settings: { edgeOpacity: number; labelDensity: number; labels: boolean; nodeScale: number };
  scene: { edges: { material: { opacity: number } }; positionOf(i: number): { x: number; y: number; z: number } | null; radiusOfWorld(i: number): number } | null;
  graph: { nodes: unknown[] };
  camera: { azimuth: number; polar: number; distance: number; flyTo(t: unknown, ms?: number): void };
  stage: HTMLElement;
  panel: HTMLElement | null;
  patch?(change: Record<string, unknown>): void;
}

/**
 * Resting line visibility that survives the light theme.
 *
 * 0.22 is the vendored default and was invisible in the room; 0.6 keeps links
 * clearly subordinate to the spheres while every connection is readable without
 * leaning in. Selected links stay at full opacity because the host draws them
 * on a separate material.
 */
export const RESTING_EDGE_OPACITY = 0.62;

/**
 * Sphere size, as a multiple of the copied renderer's own radius.
 *
 * The reference sizes a term by `3.4 + sqrt(w) * 5.4` world units, which at its 71-term scale
 * reads as solid balls. Memora's memories have almost no in-degree spread, so every `w` lands
 * near the same value and every sphere draws at the small end of that range -- the graph reads as
 * a scatter of dots rather than as the reference's spheres. Rather than resizing the spheres
 * inside `vendor/**` (the radius formula is the host's), the whole layer is scaled up through the
 * public `nodeScale` setting the toolbar already writes. 0.62 is 1.55x the copied 0.4: enough
 * presence that a sphere is an object, small enough next to the measured ~59-unit nearest-neighbour
 * gap that two neighbours never touch (the largest possible radius at this value is ~4.4 units).
 */
export const MEMORY_NODE_SCALE = 0.62;

/**
 * Label density for a personal memory graph.
 *
 * The vendored default (1) labels every term. Memora's graphs are small and the
 * labels are Chinese prose, which is twice as wide as the dictionary's terms, so
 * a full budget overlaps. 0.85 keeps the selected term and all its neighbours
 * plus the most connected terms; the per-frame declutter below removes what is
 * still left over.
 */
export const MEMORY_LABEL_DENSITY = 0.85;

/** Apply the two settings through the host's own patch seam when it has one. */
export function tuneDictionaryLook(host: LookHost): void {
  const change: Record<string, number> = {};
  if (host.settings.edgeOpacity < RESTING_EDGE_OPACITY) change.edgeOpacity = RESTING_EDGE_OPACITY;
  if (host.settings.labelDensity > MEMORY_LABEL_DENSITY) change.labelDensity = MEMORY_LABEL_DENSITY;
  // Only ever raise it: a reader who has already made the spheres bigger keeps their choice.
  if (host.settings.nodeScale < MEMORY_NODE_SCALE) change.nodeScale = MEMORY_NODE_SCALE;
  if (!Object.keys(change).length) return;
  if (host.patch) host.patch(change);
  else Object.assign(host.settings, change);
  // The scene material copies edgeOpacity once, in setSettings; a host without
  // patch() still has to be told, so write the live material as a fallback.
  const material = host.scene?.edges?.material;
  if (material && typeof host.settings.edgeOpacity === 'number') material.opacity = host.settings.edgeOpacity;
  reapplyEdgeOpacity(host);
}

/** The host rebuilds the scene when the note changes and resets the material; keep the value. */
export function reapplyEdgeOpacity(host: LookHost): void {
  const material = host.scene?.edges?.material;
  if (material) material.opacity = Math.max(material.opacity, RESTING_EDGE_OPACITY);
}

// --- label declutter ---------------------------------------------------------

/** One label as the screen shows it. */
export interface LabelBox {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** 0 = selected, 1 = neighbour, 3 = ordinary; lower wins. */
  priority: number;
}

/**
 * Which labels may stay on screen. Pure, so the test drives exactly the code the
 * browser runs.
 *
 * Priority labels (selected, neighbours) are always kept, even when they touch
 * something: they answer "what did I just click". Ordinary labels are placed in
 * reading order and dropped when their box would land on a box already placed.
 * A coarse grid keeps this linear in label count rather than quadratic.
 */
export function pickLabels(boxes: LabelBox[], cell = 16): Set<string> {
  const keep = new Set<string>();
  const cells = new Map<string, true>();
  const order = [...boxes].sort((a, b) => a.priority - b.priority || a.top - b.top || a.left - b.left);
  const blocked = (box: LabelBox): boolean => {
    const x0 = Math.floor((box.left + 1) / cell), x1 = Math.floor((box.left + box.width - 1) / cell);
    const y0 = Math.floor((box.top + 1) / cell), y1 = Math.floor((box.top + box.height - 1) / cell);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (cells.has(x + ',' + y)) return true;
    return false;
  };
  const occupy = (box: LabelBox): void => {
    const x0 = Math.floor((box.left + 1) / cell), x1 = Math.floor((box.left + box.width - 1) / cell);
    const y0 = Math.floor((box.top + 1) / cell), y1 = Math.floor((box.top + box.height - 1) / cell);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.set(x + ',' + y, true);
  };
  for (const box of order) {
    if (box.priority <= 1) { keep.add(box.id); occupy(box); continue; }
    if (blocked(box)) continue;
    keep.add(box.id);
    occupy(box);
  }
  return keep;
}

/**
 * Keep the dictionary's label layer from printing names on top of each other,
 * and make its "显示标签" switch actually work.
 *
 * The host owns `style.display`, so this does not touch it: it toggles
 * `visibility`, which the host never sets, and re-evaluates every frame from the
 * positions the host just wrote. A camera move or a new selection is reflected on
 * the next frame without any event wiring, and the switch is read every frame so
 * turning labels off (or on) takes effect immediately.
 */
export function installLabelDeclutter(root: HTMLElement, labelsEnabled: () => boolean): () => void {
  let frame = 0;
  let disposed = false;
  const tick = (): void => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const labels = [...root.querySelectorAll<HTMLElement>('.dg-label')]
      .filter(el => el.style.display !== 'none');
    // The copied layer's "显示标签" switch is broken on its own: when `labels` goes false it
    // hides each slot and continues, but never clears `slot.visible`, so the second pass of the
    // same frame puts every label back. Its own `hide`/`display` handling is otherwise fine,
    // so the switch is honoured here instead of inside `vendor/**`: the layer root is hidden as
    // a whole, which is exactly what the toggle claims to do and recovers on the next frame.
    const enabled = labelsEnabled();
    root.style.visibility = enabled ? '' : 'hidden';
    if (!enabled || !labels.length) return;
    const boxes: LabelBox[] = [];
    const byId = new Map<string, HTMLElement>();
    labels.forEach((el, index) => {
      // Visibility is reset before measuring: a label hidden on the previous
      // frame still has a box, and leaving it hidden would stop it recovering.
      el.style.visibility = '';
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const id = 'label-' + index;
      byId.set(id, el);
      boxes.push({ id, left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        priority: el.classList.contains('is-selected') ? 0 : el.classList.contains('is-related') ? 1 : 3 });
    });
    if (boxes.length < 2) return;
    const keep = pickLabels(boxes);
    for (const [id, el] of byId) if (!keep.has(id)) el.style.visibility = 'hidden';
  };
  frame = requestAnimationFrame(tick);
  return () => { disposed = true; cancelAnimationFrame(frame); };
}

// --- first frame -------------------------------------------------------------

/** Field of view the dictionary's orbit camera draws with. */
const DICTIONARY_FOV = 50;

/**
 * Frame every node of the dictionary view the way a selection is framed.
 *
 * The host's own overview fits a bounding SPHERE to the tighter axis, which on a
 * wide stage stands too far back and clusters the names; fitting the projected
 * extent instead is the same policy `brain-focus` applies to a clicked cluster,
 * so the first frame and a click agree about what "framed" means. The camera is
 * moved through the host's public flyTo; nothing in `vendor/**` is touched.
 */
export function frameDictionaryOverview(
  host: LookHost,
  viewport: { width: number; height: number },
  reserveRight = Math.min(180, Math.max(56, Math.round(viewport.width * 0.16))),
): boolean {
  const scene = host.scene;
  if (!scene || !host.graph.nodes.length) return false;
  const spheres: FocusSphere[] = [];
  for (let i = 0; i < host.graph.nodes.length; i++) {
    const at = scene.positionOf(i);
    if (!at) continue;
    spheres.push({ x: at.x, y: at.y, z: at.z, r: Math.max(1, scene.radiusOfWorld(i)) });
  }
  if (!spheres.length) return false;
  // maxFill is raised past the fit floor on purpose: that floor exists so a click on a
  // single node never fills the window, but the overview has a whole graph to show and the
  // floor (computed from the *smaller* half-axis) would leave half of a wide stage empty.
  // margin 1.04 instead of the 1.12 used for a click: a click has to leave room for the panel
  // that is about to open beside the cluster, while the overview has the whole stage and a small
  // further trim is exactly the difference between "a graph floating in whitespace" and "a nebula
  // filling the window". maxFill stays high so the fit is not floored back out.
  // Pick the VIEWPOINT as well as the distance, not just the distance.
  //
  // This used to keep whatever azimuth/polar the camera happened to be at and only fit the range.
  // The initial pose is a hard-coded default, so the first frame was a lottery: a cloud seen
  // edge-on collapses into a stripe and the whole brain view opened looking broken. bestAngles()
  // scores a ring of azimuths and a few tilts by projected screen fill (and penalises stripes),
  // which is exactly "rotate to the best viewing angle" for the whole graph.
  const angles = bestAngles(spheres, viewport, { fov: DICTIONARY_FOV, reserveRight, maxFill: 6 });
  const pose = frameCluster(spheres, angles.azimuth, angles.polar, viewport,
    { fov: DICTIONARY_FOV, margin: 1.08, reserveRight, maxFill: 6 });
  if (!pose) return false;
  host.camera.flyTo({
    pivot: new Vector3(pose.target.x, pose.target.y, pose.target.z),
    azimuth: angles.azimuth,
    polar: angles.polar,
    distance: pose.distance,
  }, 400);
  return true;
}
