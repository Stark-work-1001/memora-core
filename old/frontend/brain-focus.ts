/**
 * Applying the framing policy to the two copied 3D views.
 *
 * `focus.ts` decides where the camera should go; this module is the only place
 * that knows how to ask each vendor host to go there. The hosts themselves are
 * third-party and are not edited, so the seam is the public `select(index,
 * focus)` method both expose: it is re-bound to the same method with `focus`
 * forced off, and the camera move is issued here instead.
 *
 * That split matters for a second reason. Both vendor hosts interleave the
 * camera move with the selection change, so the host's own framing runs before
 * the detail panel has opened — which is why a cluster could be fitted to a
 * stage that was about to shrink by 380px. Doing the move after the selection
 * has been applied means the insets are measured against the stage the user
 * will actually see.
 */
import { Vector3, Quaternion } from 'three';
import {
  bestAngles, downwardness, focusDuration, focusSet, frameCluster, lookQuaternion,
  type FocusSphere, type FrameViewport, type Pose,
} from './focus';
import { reducedMotion, stageInsets } from './focus-dom';

/** Field of view both views draw with; the fit has to use the real number. */
const FOV = 50;
/** Room around the cluster: 12% of its extent, so it never touches the edge. */
const MARGIN = 1.12;
/**
 * Pixels kept clear on the right for labels. Both views draw each node's name
 * beside it (the stylesheet caps a label at 240px), so a cluster fitted to the
 * full width puts the rightmost names off screen even though every sphere is
 * technically inside.
 */
const labelGutter = (viewport: FrameViewport): number =>
  Math.min(180, Math.max(56, Math.round(viewport.width * 0.16)));

/** A node's world position and drawn radius, however the host stores them. */
function sphereFrom(position: { x: number; y: number; z: number }, radius: number): FocusSphere {
  return { x: position.x, y: position.y, z: position.z, r: Math.max(1, radius) };
}

/** Screen radius of a world-space sphere, in CSS px, for the flow overlay. */
function screenRadius(project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null,
  at: { x: number; y: number; z: number }, radius: number): number {
  const centre = project(at);
  const above = project({ x: at.x, y: at.y + radius, z: at.z });
  if (!centre || !above) return 0;
  return Math.abs(centre.y - above.y);
}

// --- dictionary -------------------------------------------------------------

/** The dictionary host, described by what this module uses. */
export interface DictionaryHost {
  select(index: number, focus: boolean): void;
  graph: {
    nodes: Array<{ position: [number, number, number]; section: number }>;
  };
  index: { neighbours: number[][] };
  scene: {
    positionOf(index: number): { x: number; y: number; z: number } | null;
    radiusOfWorld(index: number): number;
  } | null;
  camera: {
    azimuth: number; polar: number; distance: number;
    flyTo(target: { pivot: Vector3; azimuth?: number; polar?: number; distance?: number }, ms?: number): void;
  };
  stage: HTMLElement;
  panel: HTMLElement | null;
}

/**
 * Take over camera framing for the dictionary view.
 *
 * Clicking a node frames it together with everything one edge away. A node with
 * no links is framed with the rest of its section instead, so the click never
 * lands on an empty window with one dot in it.
 */
export interface FocusReport {
  /** Node indices that were framed, selected one first. */
  ids: number[];
  /** The pose the camera was sent to, or null when nothing was framed. */
  pose: Pose | null;
  /** The stage rectangle the fit had to work inside, panels already removed. */
  viewport: FrameViewport;
  /** The viewing direction the policy chose, in the view's own convention. */
  angles: { azimuth: number; polar: number };
  /** Set while a camera move is running; cleared when it lands. */
  moving: boolean;
}

export function installDictionaryFocus(host: DictionaryHost): void {
  const select = host.select.bind(host);
  host.select = (index: number, focus: boolean): void => {
    select(index, false);
    if (!focus) return;
    const report = frameDictionary(host, index);
    // Exposed for the acceptance run and for diagnosing a framing regression
    // without reading pixels back out of a WebGL canvas.
    (globalThis as any).memoraFocus = report;
  };
  (globalThis as any).frameDictionary = (index: number): FocusReport | null => {
    const report = frameDictionary(host, index);
    (globalThis as any).memoraFocus = report;
    return report;
  };
}

export function frameDictionary(host: DictionaryHost, index: number): FocusReport | null {
  const nodes = host.graph.nodes;
  if (!host.scene || index < 0 || index >= nodes.length) return null;

  const neighbours = host.index.neighbours[index] ?? [];
  // A term with no links is framed with the terms nearest to it, which is what
  // the reader is looking at anyway. Section-mates are preferred, but only
  // among the genuinely nearby: a section can be spread across the whole graph,
  // and pulling the frame out to its far end would show nothing useful.
  const origin = host.scene.positionOf(index);
  const distanceTo = (at: number): number => {
    const other = host.scene!.positionOf(at);
    if (!origin || !other) return Number.POSITIVE_INFINITY;
    return Math.hypot(other.x - origin.x, other.y - origin.y, other.z - origin.z);
  };
  const nearby = nodes
    .map((node, at) => ({ at, section: node.section, distance: at === index ? Number.POSITIVE_INFINITY : distanceTo(at) }))
    .sort((a, b) => (a.section === nodes[index].section ? 0 : 1) - (b.section === nodes[index].section ? 0 : 1)
      || a.distance - b.distance)
    .map(entry => entry.at);
  const ids = focusSet(index, neighbours, nearby);
  const spheres = ids.flatMap(id => {
    const position = host.scene!.positionOf(id);
    return position ? [sphereFrom(position, host.scene!.radiusOfWorld(id))] : [];
  });
  if (!spheres.length) return null;

  const viewport = stageInsets({ stage: host.stage, panel: host.panel });
  const keep = { azimuth: host.camera.azimuth, polar: host.camera.polar };
  const fit = { fov: FOV, margin: MARGIN, reserveRight: labelGutter(viewport) };
  const angles = bestAngles(spheres, viewport, { ...fit, keep });
  const pose = frameCluster(spheres, angles.azimuth, angles.polar, viewport, fit);
  if (!pose) return null;

  host.camera.flyTo({
    pivot: new Vector3(pose.target.x, pose.target.y, pose.target.z),
    azimuth: angles.azimuth,
    polar: angles.polar,
    distance: pose.distance,
  }, focusDuration(reducedMotion()));
  return { ids, pose, viewport, angles, moving: true };
}

// --- outline ----------------------------------------------------------------

/** The hierarchy host, described by what this module uses. */
export interface OutlineHost {
  select(id: string | null, focus: boolean): void;
  selectedId: string | null;
  graph: {
    ids: string[];
    index: Map<string, number>;
    hierarchy: Array<[number, number]>;
    documentOrder: Array<[number, number]>;
  } | null;
  engine: {
    count: number;
    spheres(indices?: number[], final?: boolean): FocusSphere[];
  };
  rendererRef: {
    camera: { position: { x: number; y: number; z: number } };
    rig: {
      viewport: { width: number; height: number };
      insets: { top: number; right: number; bottom: number; left: number };
      pivot: Vector3;
      distance: number;
      animating: boolean;
      flyTo(target: { pivot?: Vector3; orientation?: Quaternion; offset?: Vector3; fov?: number }, ms?: number): void;
      toSpherical(): { radius: number; azimuth: number; polar: number };
    };
    project(p: { x: number; y: number; z: number }): { x: number; y: number } | null;
  };
  stage: HTMLElement;
  inspector: HTMLElement | null;
}

/**
 * Take over camera framing for the hierarchy view.
 *
 * A node is framed with its parent and children. The viewing direction is
 * chosen as usual, but directions in which the parent sits *above* the child
 * are preferred, which is what makes the hierarchy read top-down instead of
 * mirrored, on its side, or upside down.
 */
export function installOutlineFocus(host: OutlineHost): void {
  const select = host.select.bind(host);
  host.select = (id: string | null, focus: boolean): void => {
    select(id, false);
    if (!focus || !id) return;
    (globalThis as any).memoraFocus = frameOutline(host, id);
  };
  (globalThis as any).frameOutlineNode = (id: string): FocusReport | null => {
    const report = frameOutline(host, id);
    (globalThis as any).memoraFocus = report;
    return report;
  };
}

export function frameOutline(host: OutlineHost, id: string): FocusReport | null {
  const graph = host.graph;
  if (!graph) return null;
  const index = graph.index.get(id);
  if (index === undefined) return null;

  const related = [index];
  for (const [parent, child] of graph.hierarchy) {
    if (parent === index) related.push(child);
    if (child === index) related.push(parent);
  }
  // Parent and children are the neighbourhood. A leaf with no children gets
  // nothing extra: in a hierarchy the surrounding nodes are already the point,
  // and padding the frame with unrelated siblings would trade that context for
  // noise. `focusSet` is still what decides, so a totally isolated node falls
  // back to its document-order neighbours rather than to itself alone.
  const ids = focusSet(index, related.slice(1), graph.documentOrder.flatMap(([a, b]) =>
    a === index ? [b] : b === index ? [a] : []));
  const spheres = host.engine.spheres(ids);
  if (!spheres.length) return null;

  const viewport = stageInsets({ stage: host.stage, inspector: host.inspector });
  const spherical = host.rendererRef.rig.toSpherical();
  // Direction is judged on the edges that are actually on screen: the ones
  // between nodes in this cluster. Judging it against the whole hierarchy would
  // pick a direction that is downward overall and still shows the framed pair
  // upside down, which is exactly the reading the cue has to prevent.
  const framed = new Set(ids);
  const hierarchySpheres = graph.hierarchy
    .filter(([parent, child]) => framed.has(parent) && framed.has(child))
    .map(([parent, child]) => {
      const pair = host.engine.spheres([parent, child]);
      return pair.length === 2 ? { parent: pair[0], child: pair[1] } : null;
    })
    .filter((edge): edge is { parent: FocusSphere; child: FocusSphere } => edge !== null);

  const fit = { fov: FOV, margin: MARGIN, reserveRight: labelGutter(viewport) };
  const angles = bestAngles(spheres, viewport, {
    ...fit,
    keep: { azimuth: spherical.azimuth, polar: spherical.polar },
    // Upper hemisphere only: the map is read from above, so a "clearer" view
    // from underneath would still be wrong even if it spread out further.
    polars: [0.35, 0.55, 0.8, 1.05, 1.3, 1.5],
    bias: (azimuth, polar) => downwardness(hierarchySpheres, azimuth, polar),
  });
  const pose = frameCluster(spheres, angles.azimuth, angles.polar, viewport, fit);
  if (!pose) return null;

  const quaternion = lookQuaternion(pose.eye, pose.target);
  host.rendererRef.rig.flyTo({
    pivot: new Vector3(pose.target.x, pose.target.y, pose.target.z),
    orientation: new Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]),
    offset: new Vector3(0, 0, pose.distance),
  }, focusDuration(reducedMotion()));
  return { ids, pose, viewport, angles, moving: true };
}

// --- hierarchy direction cue --------------------------------------------------

const FLOW_SPEED = 0.42;      // laps per second along each edge
const FLOW_DOTS = 3;          // dots per edge at any moment
const FLOW_COLOUR = '#1d7959';
const FLOW_DIM = 'rgba(29,121,89,0.34)';

/**
 * A first-party direction cue for the hierarchy view.
 *
 * The copied renderer already pulses its edges, but the pulse is a narrow band
 * mixed into an already-faint line: measured frame to frame it changes about
 * 0.006% of the pixels, which is not something a reader can follow. This draws
 * the direction explicitly instead — a chevron at the child end of every
 * hierarchy edge, and dots that travel parent to child while motion is allowed.
 *
 * With reduced motion the dots are dropped and the chevrons stay, so the
 * direction is still on screen without anything moving.
 */
export interface FlowOverlay {
  draw(): void;
  setEnabled(enabled: boolean): void;
  /** What the last draw put on screen, for the acceptance run and for tests. */
  stats(): FlowStats;
  dispose(): void;
}

export interface FlowStats {
  /** Chevrons drawn, one per visible hierarchy edge. */
  chevrons: number;
  /** Chevrons that point down the screen, i.e. from a higher node to a lower one. */
  downward: number;
  /** Travelling dots drawn in the last frame; zero when motion is suppressed. */
  dots: number;
  /** True while the moving part of the cue is enabled. */
  animate: boolean;
  width: number;
  height: number;
}

export function installFlowOverlay(host: OutlineHost): FlowOverlay | null {
  const stage = host.stage;
  if (!stage) return null;
  const canvas = document.createElement('canvas');
  canvas.className = 'memora-flow';
  canvas.setAttribute('aria-hidden', 'true');
  stage.append(canvas);
  const context = canvas.getContext('2d');
  if (!context) { canvas.remove(); return null; }

  // The motion preference is a live query, not a value read once at start-up:
  // a reader who turns reduced motion on while the view is open must not have to
  // reload to stop the dots.
  const preference = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  let enabled = !preference?.matches;
  let width = 1, height = 1, ratio = 1;
  const drawn: FlowStats = { chevrons: 0, downward: 0, dots: 0, animate: enabled, width: 1, height: 1 };
  // Declared before the API object so the media listener and the public toggle
  // share one implementation.
  const applyEnabled = (value: boolean): void => {
    enabled = value;
    if (enabled) start(); else { if (raf) cancelAnimationFrame(raf); raf = 0; draw(); }
  };
  const onPreference = (): void => {
    // Turning motion off stops the travelling dots but keeps the chevrons: the
    // direction is still on screen, it just stops moving.
    applyEnabled(!preference?.matches);
  };
  preference?.addEventListener?.('change', onPreference);

  const resize = (): void => {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
  };

  function draw(): void {
    if (!context) return;
    const graph = host.graph;
    const rig = host.rendererRef?.rig;
    if (!graph || !rig) { context.clearRect(0, 0, width, height); return; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    drawn.chevrons = 0; drawn.downward = 0; drawn.dots = 0;
    drawn.animate = enabled; drawn.width = width; drawn.height = height;
    const project = host.rendererRef.project.bind(host.rendererRef);
    const now = performance.now() / 1000;

    for (const [parent, child] of graph.hierarchy) {
      const pair = host.engine.spheres([parent, child]);
      if (pair.length !== 2) continue;
      const from = { x: pair[0].x, y: pair[0].y, z: pair[0].z };
      const to = { x: pair[1].x, y: pair[1].y, z: pair[1].z };
      const a = project(from), b = project(to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 24) continue;
      const ux = dx / length, uy = dy / length;
      const startInset = screenRadius(project, from, pair[0].r) + 3;
      const endInset = screenRadius(project, to, pair[1].r) + 5;
      const ax = a.x + ux * startInset, ay = a.y + uy * startInset;
      const bx = b.x - ux * endInset, by = b.y - uy * endInset;
      const span = Math.hypot(bx - ax, by - ay);
      if (span < 10) continue;

      // Chevron at the child end, pointing at it. Direction is read from the
      // child end, so it is correct for the edge even when the camera is not
      // looking at the hierarchy from the direction the layout was authored in:
      // a parent/child pair drawn with the child lower points down, one drawn
      // with the child higher points up, and either way the arrow follows the
      // parent-to-child relation rather than an assumed screen orientation.
      const tipX = bx, tipY = by;
      const notch = Math.min(9, span * 0.22);
      const half = notch * 0.62;
      context.beginPath();
      context.moveTo(tipX - ux * notch + uy * half, tipY - uy * notch - ux * half);
      context.lineTo(tipX, tipY);
      context.lineTo(tipX - ux * notch - uy * half, tipY - uy * notch + ux * half);
      context.strokeStyle = FLOW_COLOUR;
      context.lineWidth = 1.8;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.stroke();
      drawn.chevrons++;
      if (by > ay) drawn.downward++;

      if (!enabled) continue;
      // Dots travelling parent -> child: the moving part of the cue. Their
      // motion is what makes the direction unambiguous even on an edge that a
      // given camera angle happens to draw sideways.
      for (let dot = 0; dot < FLOW_DOTS; dot++) {
        const phase = (now * FLOW_SPEED + dot / FLOW_DOTS) % 1;
        const t0 = 0.12 + phase * 0.76;
        const x = ax + (bx - ax) * t0;
        const y = ay + (by - ay) * t0;
        const fade = Math.sin(Math.PI * phase);
        context.beginPath();
        context.arc(x, y, 2.1, 0, Math.PI * 2);
        context.fillStyle = fade > 0.35 ? FLOW_COLOUR : FLOW_DIM;
        context.globalAlpha = 0.35 + fade * 0.55;
        context.fill();
        context.globalAlpha = 1;
        drawn.dots++;
      }
    }
  }

  resize();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { resize(); draw(); });
  observer?.observe(stage);

  // Redraw whenever the renderer draws: that is exactly when positions, the
  // camera, or the emphasis can have changed. The copied renderer keeps frames
  // coming while its own flow is enabled, which is the same switch this reads.
  const renderer = host.rendererRef as unknown as { afterFrame?: ((moving: boolean) => void) | null };
  const previous = renderer.afterFrame ?? null;
  renderer.afterFrame = (moving: boolean): void => { previous?.(moving); draw(); };

  let raf = 0;
  const tick = (): void => {
    if (!enabled || document.hidden) { raf = 0; return; }
    draw();
    raf = requestAnimationFrame(tick);
  };
  const start = (): void => { if (enabled && !raf && !document.hidden) raf = requestAnimationFrame(tick); };
  start();
  draw();

  const api: FlowOverlay = {
    draw,
    stats(): FlowStats { return { ...drawn }; },
    setEnabled(value: boolean): void { applyEnabled(value); },
    dispose(): void {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      preference?.removeEventListener?.('change', onPreference);
      renderer.afterFrame = previous;
      canvas.remove();
    },
  };
  return api;
}