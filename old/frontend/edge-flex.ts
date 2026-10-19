/**
 * Edges that flex with the viewing direction.
 *
 * THE PROBLEM
 * -----------
 * All three renderers draw their links once, from world-space geometry, and then never touch them
 * again: rotating the camera slides the lines rigidly across the screen. A link that happens to
 * point at the camera collapses to a few pixels and disappears, and nothing about the drawing says
 * which way the graph is being read.
 *
 * THE RULE (one rule, three renderers)
 * ------------------------------------
 * For each link, with `axis` its world direction and `view` the camera's forward vector:
 *
 *   facing  = |axis · view|                      0 = edge lies across the screen, 1 = edge points at you
 *   side    = axis x view, normalised            the direction that is most visible on screen
 *   bow     = |baked base| + FACING_BOW * len * facing^2
 *   control = midpoint + blend(bakedDirection, side, facing^2) * bow
 *
 * Two properties follow, and they are the two the user asked for:
 *
 *  - **柔性弯曲**: an edge that points at the camera (which used to be a dot) bows out sideways on
 *    screen, and the bow grows smoothly with the angle instead of snapping between states.
 *  - **伸缩**: the bow is a fraction of the edge's own length and the baked base is preserved when
 *    the edge is seen side-on, so a link keeps its reference shape at rest and stretches only as
 *    the view turns — the arc length ratio is reported by `flexMetrics`.
 *
 * The deformed geometry is DERIVED, never stored: `graph.edges[i].control` is left exactly as the
 * layout baked it, so the matt bake's measured 0.16 ratio stays true and the data is unchanged.
 *
 * WHERE IT RUNS, PER RENDERER
 * ---------------------------
 *  - dictionary / matt (dictionary-graph): the resting and selected layers are `LineSegments`
 *    inside the host's public `scene` (three.js objects). Their position attribute is rewritten
 *    from the same quadratic sampling the vendor uses, throttled and skipped when the camera has
 *    not turned. CPU-bounded: see `updateInterval`.
 *  - outline (original-dev): both link layers are instanced shaders. Their control point is
 *    computed in the VERTEX SHADER from `cameraPosition` (a three.js built-in uniform), so the
 *    cost is zero on the CPU at any graph size. The shader text is patched on the material object
 *    the renderer already exposes; no vendor file is edited.
 *
 * `vendor/**` is untouched: the dictionary layers are found by walking the public three.js scene
 * graph, and the outline layers are reached through the renderer's public `edges`/`links` fields
 * and their public three.js materials.
 */
import { Vector3 } from 'three';

export interface Vec3 { x: number; y: number; z: number }

/** A link as the deformation needs it: two endpoints and the layout's own control point. */
export interface FlexEdge {
  a: Vec3;
  b: Vec3;
  /** The baked control point (matt's cross-section arc), or null for a straight link. */
  control: Vec3 | null;
}

/** How much a link bows, and how that bow was derived. Pure, so the tests drive the real maths. */
export interface FlexResult {
  /** The control point the renderer should use. */
  control: Vec3;
  /** |axis . view| for this link: 0 lies across the screen, 1 points at the camera. */
  facing: number;
  /** |control - midpoint| in world units (the offset of the Bezier control point). */
  bow: number;
  /**
   * bow / |b - a|: the CONTROL-OFFSET ratio, the same quantity matt-layout.ts measures on the
   * reference site (it is exactly 0.16 there for cross-section links).
   *
   * Note this is not the arc's sagitta: a quadratic Bezier reaches only half way to its control
   * point, so the geometric depth of the curve is `sagitta / 2`. Both are reported because the
   * reference rule is stated in the control-offset form and arc length is not.
   */
  sagitta: number;
  /** The geometric depth of the curve, in world units: (sagitta / 2) * |b - a|. */
  depth: number;
  /** Arc length / chord length, numerically sampled (1 = a straight line). */
  arcRatio: number;
  /** True when the bow direction had to fall back to an arbitrary perpendicular. */
  degenerate: boolean;
}

/**
 * Bow added when the link points straight at the camera, as a fraction of its length.
 *
 * 0.18 is a perceptual choice made against the three views at their real sizes: below ~0.10 the
 * bow of a foreshortened edge is under a pixel at typical zoom, and above ~0.28 a link that is
 * merely tilted swings wide enough to be mistaken for matt's cross-section arcs.
 */
export const FACING_BOW = 0.18;
/**
 * Minimum bow, as a fraction of the link's length, for a link with no baked curve.
 *
 * The dictionary view's links are straight by design (its layout is a spring embedder, and its
 * committed `control === null`). A 3% resting bow keeps that reading — a relation graph, not a
 * nebula — while still being enough that the shape responds visibly when the camera turns.
 */
export const BASE_BOW = 0.03;
/** How much of the baked direction survives at full facing (the rest swings to the screen plane). */
export const BAKED_DIRECTION_KEEP = 0.35;

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function unit(a: Vec3): Vec3 {
  const size = len(a);
  return size < 1e-9 ? { x: 0, y: 1, z: 0 } : mul(a, 1 / size);
}

/** Any unit vector perpendicular to `d`, used when the bow direction is degenerate. */
function perpendicular(d: Vec3): Vec3 {
  const reference = Math.abs(d.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  return unit(cross(d, reference));
}

/** Arc length of the quadratic Bezier a -> control -> b, sampled; /|b - a| is the stretch ratio. */
export function arcRatio(a: Vec3, control: Vec3, b: Vec3, samples = 12): number {
  const chord = len(sub(b, a));
  if (chord < 1e-9) return 1;
  let total = 0;
  let previous = a;
  for (let step = 1; step <= samples; step++) {
    const t = step / samples, u = 1 - t;
    const point: Vec3 = {
      x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
      z: u * u * a.z + 2 * u * t * control.z + t * t * b.z,
    };
    total += len(sub(point, previous));
    previous = point;
  }
  return total / chord;
}

/**
 * The control point a link should use for one viewing direction.
 *
 * Deterministic and side-effect free: the acceptance run and the unit tests call exactly this,
 * and the renderers consume its output.
 */
export function flexControl(edge: FlexEdge, view: Vec3, options: { facingBow?: number; baseBow?: number } = {}): FlexResult {
  const facingBow = options.facingBow ?? FACING_BOW;
  const baseBow = options.baseBow ?? BASE_BOW;
  const axis = sub(edge.b, edge.a);
  const length = len(axis);
  const midpoint = mul(add(edge.a, edge.b), 0.5);
  if (length < 1e-9) {
    return { control: midpoint, facing: 0, bow: 0, sagitta: 0, depth: 0, arcRatio: 1, degenerate: false };
  }
  const direction = unit(axis);
  const facing = Math.min(1, Math.abs(dot(direction, unit(view))));
  // The most visible bow direction: perpendicular to the link AND to the view, i.e. lying in the
  // screen plane. A bow along any other axis is partly hidden behind the line itself.
  const perpendicularToView = cross(direction, unit(view));
  const degenerate = len(perpendicularToView) < 1e-4;
  const side = degenerate ? perpendicular(direction) : unit(perpendicularToView);

  const baked = edge.control ? sub(edge.control, midpoint) : null;
  const bakedLength = baked ? len(baked) : 0;
  const bakedDirection = bakedLength > 1e-9 ? unit(baked!) : null;

  // Bow: the layout's own curve is a floor, and facing the camera adds on top of it.
  const floor = Math.max(bakedLength, length * baseBow);
  const bow = floor + length * facingBow * facing * facing;

  // Direction: at rest the baked curve is used as-authored (matt's 0.16 arcs stay exactly as the
  // reference has them); as the link turns towards the camera the bow swings into the screen
  // plane, where it can actually be seen.
  const swing = facing * facing;
  let directionOut: Vec3;
  if (bakedDirection) {
    const keep = 1 - swing * (1 - BAKED_DIRECTION_KEEP);
    directionOut = unit(add(mul(bakedDirection, keep), mul(side, swing * (1 - BAKED_DIRECTION_KEEP))));
  } else {
    directionOut = side;
  }
  const control = add(midpoint, mul(directionOut, bow));
  return {
    control,
    facing,
    bow,
    sagitta: bow / length,
    depth: bow / 2,
    arcRatio: arcRatio(edge.a, control, edge.b),
    degenerate,
  };
}

/** Camera forward vector, in world space. */
export function cameraForward(camera: { getWorldDirection(target: Vector3): Vector3 } | null | undefined): Vec3 {
  if (!camera) return { x: 0, y: 0, z: 1 };
  const out = camera.getWorldDirection(new Vector3());
  return { x: out.x, y: out.y, z: out.z };
}

/** Angle between two unit-ish vectors, in radians; used to decide whether a rebuild is worth it. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const cosine = Math.max(-1, Math.min(1, dot(unit(a), unit(b))));
  return Math.acos(cosine);
}

/**
 * How long to wait between geometry rewrites, as a function of the vertex count.
 *
 * A rewrite is O(edges x segments); the budget is what keeps a 880-node project from spending its
 * frame on line sampling. Measured on this machine at 14 segments: ~0.06 ms per 1000 vertices, so
 * the caps below leave the update at roughly 1-2 ms even at the slow end (30 fps for a small graph,
 * 12 fps for one large enough that the GPU upload dominates).
 */
export function updateInterval(vertices: number): number {
  if (vertices <= 12000) return 28;
  if (vertices <= 40000) return 55;
  return 90;
}
