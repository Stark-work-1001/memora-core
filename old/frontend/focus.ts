/**
 * Memora's framing policy for the two copied 3D views.
 *
 * Both vendored renderers ship a "focus this cluster" call, and both fit a
 * bounding *sphere* to the tighter screen axis. That is the wrong shape for the
 * job. A parent plus one child spans mostly one way; a sphere inflates to the
 * longest edge, so the pair lands as two specks with a wide empty band on the
 * other axis — horizontal on a portrait window, vertical on a wide one. On top
 * of that, a lone node with no linkage is fitted to itself and fills the whole
 * window, which hides the context the click was asking for.
 *
 * This module fits the cluster's *projected extent*, per axis, inside the part
 * of the stage that no panel covers, and never zooms past a share of the free
 * area. Everything here is pure: positions and radii in, a camera pose out. The
 * views own the animation; the tests drive exactly the code the browser runs.
 */

/** A node as the framer needs it: where it is and how big it is drawn. */
export interface FocusSphere { x: number; y: number; z: number; r: number }

/** A viewport in CSS pixels, plus the part of it a panel covers. */
export interface FrameViewport {
  width: number;
  height: number;
  /** Pixels lost to a panel on each side; 0 when nothing overlays the stage. */
  insetTop?: number;
  insetRight?: number;
  insetBottom?: number;
  insetLeft?: number;
}

export interface FrameOptions {
  /** Breathing room around the cluster: 1.12 = fitted extent plus 12%. */
  margin?: number;
  /** Vertical field of view, in degrees (the dictionary's orbit uses 50). */
  fov?: number;
  /** Closest and furthest the camera may end up. */
  minDistance?: number;
  maxDistance?: number;
  /** The cluster may never cover more than this share of the free area. */
  maxFill?: number;
  /**
   * Pixels kept free on the right for node labels. Both views draw a label to
   * the right of each node, so a node sitting at the right edge of the free
   * window has its *body* in shot and its name outside it.
   */
  reserveRight?: number;
}

export interface Pose {
  /** Where the camera looks: the centre of the free area, held on the cluster. */
  target: { x: number; y: number; z: number };
  /** Eye position. */
  eye: { x: number; y: number; z: number };
  distance: number;
  /** Half-extent of the fitted projected box, in world units. */
  radius: number;
  /** The distance the fit asked for, before the "do not over-zoom" floor. */
  fitted: number;
  /** How much of the free area the cluster covers, per axis, 0..1. */
  fill: { x: number; y: number };
}

const DEG = Math.PI / 180;

/**
 * Basis of a camera at `azimuth`/`polar` looking at the origin, in the orbit
 * convention the dictionary renderer already uses:
 * eye = distance * (sin(polar)sin(azimuth), cos(polar), sin(polar)cos(azimuth)).
 * `right`/`up` are orthonormal with `dir`, so a dot product is the camera-space
 * coordinate and no matrix work is needed. The triple is identical to what
 * `lookQuaternion` builds, so the outline view can use either.
 */
export function cameraBasis(azimuth: number, polar: number) {
  const sinPolar = Math.sin(polar), cosPolar = Math.cos(polar);
  const dir = { x: sinPolar * Math.sin(azimuth), y: cosPolar, z: sinPolar * Math.cos(azimuth) };
  const length = Math.hypot(dir.z, 0, -dir.x);
  const right = length < 1e-6
    ? { x: 1, y: 0, z: 0 }
    : { x: dir.z / length, y: 0, z: -dir.x / length };
  const up = {
    x: dir.y * right.z - dir.z * right.y,
    y: dir.z * right.x - dir.x * right.z,
    z: dir.x * right.y - dir.y * right.x,
  };
  return { dir, right, up };
}

/**
 * The region of the stage the cluster must land in, in NDC (-1..1, y up) of the
 * full viewport, plus the tangents that convert camera-space offsets to NDC.
 */
export function freeWindow(viewport: FrameViewport, fov = 50, reserveRight = 0) {
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const x0 = Math.max(-1, -1 + 2 * (viewport.insetLeft ?? 0) / width);
  const x1 = Math.min(1, 1 - 2 * ((viewport.insetRight ?? 0) + Math.max(0, reserveRight)) / width);
  const y0 = Math.max(-1, -1 + 2 * (viewport.insetBottom ?? 0) / height);
  const y1 = Math.min(1, 1 - 2 * (viewport.insetTop ?? 0) / height);
  const tanY = Math.tan(fov * DEG / 2);
  const tanX = tanY * (width / height);
  // A window squeezed to nothing (a panel covering the stage) would otherwise
  // make the fit impossible; keep a usable sliver instead.
  return {
    width, height, tanX, tanY,
    x0: Math.min(x0, x1 - 0.08), x1: Math.max(x1, x0 + 0.08),
    y0: Math.min(y0, y1 - 0.08), y1: Math.max(y1, y0 + 0.08),
  };
}

/** Cluster in camera space for one viewing direction, relative to a fixed target. */
function toLocal(spheres: FocusSphere[], azimuth: number, polar: number) {
  const basis = cameraBasis(azimuth, polar);
  const points = spheres.map(sphere => ({
    x: sphere.x * basis.right.x + sphere.y * basis.right.y + sphere.z * basis.right.z,
    y: sphere.x * basis.up.x + sphere.y * basis.up.y + sphere.z * basis.up.z,
    z: sphere.x * basis.dir.x + sphere.y * basis.dir.y + sphere.z * basis.dir.z,
    r: sphere.r,
  }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - p.r); maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r); maxY = Math.max(maxY, p.y + p.r);
  }
  // A target fixed by the *extents alone*: the centre of the projected box in
  // x/y, and the mid-depth of the cluster in z. Making the target independent
  // of the distance is what keeps the fit closed-form — a target that moved
  // with the distance made the constraint non-monotonic and the search diverge.
  const centreX = (minX + maxX) / 2, centreY = (minY + maxY) / 2;
  const centreZ = points.reduce((sum, p) => sum + p.z, 0) / points.length;
  const local = points.map(p => ({ x: p.x - centreX, y: p.y - centreY, z: p.z - centreZ, r: p.r }));
  return {
    basis, local, centreX, centreY, centreZ,
    halfX: (maxX - minX) / 2, halfY: (maxY - minY) / 2,
    spanZ: Math.max(...points.map(p => p.z)) - Math.min(...points.map(p => p.z)),
  };
}

/**
 * The closest distance at which every sphere fits the free window, with the
 * target at the cluster's own centre.
 *
 * Per point, being visible requires
 *   (|x| + r) <= (distance - z) * tanX * freeX
 * so the distance it needs is (|x| + r) / (tanX * freeX) + z. The cluster's
 * distance is the largest of those. Closed form, no iteration, and exact for
 * any depth spread — a bisection over the same inequality is not monotonic once
 * part of the cluster approaches the camera plane, which is how a two-node
 * selection ended up projected far outside the window.
 */
function fitDistance(local: Array<{ x: number; y: number; z: number; r: number }>, window: ReturnType<typeof freeWindow>) {
  const freeX = (window.x1 - window.x0) / 2;
  const freeY = (window.y1 - window.y0) / 2;
  let distance = 0;
  for (const point of local) {
    const needX = (Math.abs(point.x) + point.r) / Math.max(1e-6, window.tanX * freeX);
    const needY = (Math.abs(point.y) + point.r) / Math.max(1e-6, window.tanY * freeY);
    distance = Math.max(distance, Math.max(needX, needY) + point.z);
  }
  return distance;
}

/**
 * The camera pose that frames `spheres` from the given angles.
 *
 * The cluster's projected box is fitted per axis inside the free window, then
 * `maxFill` keeps a node with no neighbourhood from filling the window on its
 * own: the click asked for context, so a lone node is shown at a readable size
 * rather than wall-to-wall.
 */
export function frameCluster(
  spheres: FocusSphere[],
  azimuth: number,
  polar: number,
  viewport: FrameViewport,
  options: FrameOptions = {},
): Pose | null {
  if (!spheres.length) return null;
  const margin = options.margin ?? 1.12;
  const maxFill = options.maxFill ?? 0.72;
  const window = freeWindow(viewport, options.fov ?? 50, options.reserveRight ?? 0);
  const { basis, local, centreX, centreY, centreZ, halfX, halfY } = toLocal(spheres, azimuth, polar);
  const radius = Math.max(1e-3, Math.max(halfX, halfY));

  const fitted = Math.max(1e-3, fitDistance(local, window)) * margin;
  // The "do not over-zoom" floor: the cluster's radius may not cover more than
  // \`maxFill\` of the free window's smaller half-axis.
  //
  // The floor is measured against the window *without* the label gutter. The
  // gutter exists so names are not clipped, and a node's name is drawn beside
  // its sphere, so pushing the camera back for it would shrink the cluster
  // without ever bringing the label further inside — the label moves with the
  // sphere. Fitting the cluster into the guttered box is what keeps the sphere
  // clear of the edge; that is \`fitDistance\` above, and it already does it.
  const plain = freeWindow(viewport, options.fov ?? 50, 0);
  const freeX = Math.max(1e-6, window.tanX * (plain.x1 - plain.x0) / 2);
  const freeY = Math.max(1e-6, window.tanY * (plain.y1 - plain.y0) / 2);
  const floor = radius / Math.max(1e-6, maxFill * Math.min(freeX, freeY));

  let distance = Math.max(fitted, floor, options.minDistance ?? 12);
  if (options.maxDistance !== undefined) distance = Math.min(distance, options.maxDistance);

  // The target starts on the cluster's camera-space centre and is then slid
  // until the *projected* box is centred in the free window. The two are not
  // the same point: the perspective divide scales each node by its own depth,
  // and the free window itself can be lopsided when a panel sits on one side.
  const eyeOf = (target: { x: number; y: number; z: number }, at: number) => ({
    x: target.x + basis.dir.x * at,
    y: target.y + basis.dir.y * at,
    z: target.z + basis.dir.z * at,
  });
  const origin = {
    x: basis.right.x * centreX + basis.up.x * centreY + basis.dir.x * centreZ,
    y: basis.right.y * centreX + basis.up.y * centreY + basis.dir.y * centreZ,
    z: basis.right.z * centreX + basis.up.z * centreY + basis.dir.z * centreZ,
  };
  let target = { ...origin };
  const wantX = (window.x0 + window.x1) / 2, wantY = (window.y0 + window.y1) / 2;

  // Grow while the projected box is wider than the free window, then slide to
  // centre it; repeat, because the slide changes the per-node depths slightly.
  // Growing only shrinks the box, so the pair of steps converges.
  const projectedBox = () => {
    const pose: Pose = { target, eye: eyeOf(target, distance), distance, radius, fitted, fill: { x: 0, y: 0 } };
    const projected = projectSpheres(spheres, pose, azimuth, polar, viewport, options);
    let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
    for (const p of projected) {
      left = Math.min(left, p.x - p.rX); right = Math.max(right, p.x + p.rX);
      bottom = Math.min(bottom, p.y - p.rY); top = Math.max(top, p.y + p.rY);
    }
    return { pose, left, right, bottom, top };
  };
  for (let attempt = 0; attempt < 64; attempt++) {
    const box = projectedBox();
    const overflow = Math.max(window.x0 - box.left, box.right - window.x1,
      window.y0 - box.bottom, box.top - window.y1);
    if (overflow > 1e-4) {
      // Grow, keeping the target: a pure scale never moves the box's centre.
      distance *= 1.06;
      if (options.maxDistance !== undefined) distance = Math.min(distance, options.maxDistance);
      continue;
    }
    // Moving the target `d` along the camera's right axis pulls every projected
    // point `d / (depth * tanX)` back towards the centre, so the shift that
    // centres the box is its current offset from the window's middle, scaled
    // back into world units. The sign is positive: the target follows the
    // offset, it does not oppose it.
    const cX = (box.left + box.right) / 2 - wantX;
    const cY = (box.bottom + box.top) / 2 - wantY;
    const shiftX = cX * distance * window.tanX;
    const shiftY = cY * distance * window.tanY;
    if (Math.abs(shiftX) < 1e-3 * distance * window.tanX
      && Math.abs(shiftY) < 1e-3 * distance * window.tanY) break;
    target = {
      x: target.x + basis.right.x * shiftX + basis.up.x * shiftY,
      y: target.y + basis.right.y * shiftX + basis.up.y * shiftY,
      z: target.z + basis.right.z * shiftX + basis.up.z * shiftY,
    };
  }
  const pose: Pose = { target, eye: eyeOf(target, distance), distance, radius, fitted, fill: { x: 0, y: 0 } };
  return { ...pose, fill: screenFill(spheres, pose, azimuth, polar, viewport, options) };
}

/**
 * Where each sphere lands on screen (NDC, -1..1) for a pose — the same test the
 * acceptance run applies in the browser, so the unit tests fail for the reason
 * a screenshot would show. A sphere counts as inside only when its whole disc
 * is, not just its centre.
 */
export function projectSpheres(
  spheres: FocusSphere[],
  pose: Pose,
  azimuth: number,
  polar: number,
  viewport: FrameViewport,
  options: FrameOptions = {},
): Array<{ x: number; y: number; rX: number; rY: number; inside: boolean }> {
  const basis = cameraBasis(azimuth, polar);
  const window = freeWindow(viewport, options.fov ?? 50, options.reserveRight ?? 0);
  const tx = pose.target.x * basis.right.x + pose.target.y * basis.right.y + pose.target.z * basis.right.z;
  const ty = pose.target.x * basis.up.x + pose.target.y * basis.up.y + pose.target.z * basis.up.z;
  const tz = pose.target.x * basis.dir.x + pose.target.y * basis.dir.y + pose.target.z * basis.dir.z;
  return spheres.map(sphere => {
    const x = sphere.x * basis.right.x + sphere.y * basis.right.y + sphere.z * basis.right.z;
    const y = sphere.x * basis.up.x + sphere.y * basis.up.y + sphere.z * basis.up.z;
    const z = sphere.x * basis.dir.x + sphere.y * basis.dir.y + sphere.z * basis.dir.z;
    const depth = Math.max(1e-3, pose.distance - (z - tz));
    const ndcX = (x - tx) / (depth * window.tanX);
    const ndcY = (y - ty) / (depth * window.tanY);
    const rX = sphere.r / (depth * window.tanX);
    const rY = sphere.r / (depth * window.tanY);
    return {
      x: ndcX, y: ndcY, rX, rY,
      inside: ndcX - rX >= window.x0 && ndcX + rX <= window.x1
        && ndcY - rY >= window.y0 && ndcY + rY <= window.y1,
    };
  });
}

/** How much of the free window the cluster covers per axis; 1 means it fills it. */
export function screenFill(
  spheres: FocusSphere[], pose: Pose, azimuth: number, polar: number,
  viewport: FrameViewport, options: FrameOptions = {},
) {
  const window = freeWindow(viewport, options.fov ?? 50, options.reserveRight ?? 0);
  const projected = projectSpheres(spheres, pose, azimuth, polar, viewport, options);
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const p of projected) {
    left = Math.min(left, p.x - p.rX); right = Math.max(right, p.x + p.rX);
    bottom = Math.min(bottom, p.y - p.rY); top = Math.max(top, p.y + p.rY);
  }
  return {
    x: (right - left) / (window.x1 - window.x0),
    y: (top - bottom) / (window.y1 - window.y0),
  };
}

/** Azimuths tried when choosing a viewing direction. */
const AZIMUTH_STEPS = 24;
const DEFAULT_POLARS = [0.3, 0.55, 0.8, 1.05, 1.3, 1.55, 1.8];
/**
 * Readability floor, relative to the best direction found.
 *
 * Direction and readability are not the same kind of requirement. "Parent above
 * child" is a reading promise: a hierarchy drawn bottom-up is wrong however
 * well it fills the window. How well it fills the window is a quality
 * preference, negotiable. So a direction is *eligible* when it is within this
 * of the best readability, and among the eligible ones the most downward wins —
 * bias first, readability as the tie-break. A weight on the same two numbers
 * cannot express that, and a tight tolerance cannot either: for a two-node
 * cluster the readability scores are nearly arbitrary, so a narrow band can
 * exclude every direction that points the right way.
 */
const READABILITY_FLOOR = 0.34;

/**
 * The angles that present \`spheres\` best, scored by how much of the free window
 * the cluster's projected box can fill in *both* axes.
 *
 * A cluster seen edge-on collapses into a line and fills almost nothing; one
 * seen face-on fills the window and its members stop overlapping. Scoring the
 * screen fill, not the world-space spread, is what makes the choice depend on
 * the window shape rather than on the coordinates the layout happened to use.
 *
 * \`bias\` is applied lexicographically behind \`READABILITY_FLOOR\`: it reorders
 * directions that are all acceptable, and can never buy a bad frame.
 */
export function bestAngles(
  spheres: FocusSphere[],
  viewport: FrameViewport,
  options: FrameOptions & {
    keep?: { azimuth: number; polar: number };
    polars?: number[];
    bias?: (azimuth: number, polar: number) => number;
    floor?: number;
  } = {},
): { azimuth: number; polar: number } {
  const fallback = options.keep ?? { azimuth: 0.7, polar: 1.15 };
  if (spheres.length < 2) return fallback;
  const polars = options.polars ?? DEFAULT_POLARS;
  const candidates: Array<{ azimuth: number; polar: number; score: number; bias: number }> = [];
  for (const polar of polars) {
    for (let step = 0; step < AZIMUTH_STEPS; step++) {
      const azimuth = (step / AZIMUTH_STEPS) * Math.PI * 2;
      // Score every direction against the whole window. The label gutter and
      // the margin are fit-time reservations: letting them into the *scoring*
      // makes an edge-on direction look competitive, because a collapsed
      // cluster needs less room and so retains more of the reserved gutter.
      const pose = frameCluster(spheres, azimuth, polar, viewport,
        { ...options, maxDistance: undefined, reserveRight: 0 });
      if (!pose) continue;
      const fill = pose.fill;
      // Balanced coverage: the cluster should read as a shape, not as a stripe
      // in a mostly empty box.
      const cover = Math.min(1, fill.x) * 0.5 + Math.min(1, fill.y) * 0.5;
      const balance = 1 - Math.min(1, Math.abs(fill.x - fill.y));
      candidates.push({
        azimuth, polar,
        score: cover * 0.62 + balance * 0.38,
        bias: options.bias ? options.bias(azimuth, polar) : 0,
      });
    }
  }
  if (!candidates.length) return fallback;
  const top = Math.max(...candidates.map(c => c.score));
  const floor = options.floor ?? READABILITY_FLOOR;
  let eligible = candidates.filter(c => c.score >= top - floor);
  if (!eligible.length) eligible = candidates;
  if (!options.bias) return { azimuth: eligible[0].azimuth, polar: eligible[0].polar };
  // Most downward among the readable directions, readability breaking ties so
  // the choice stays stable when two directions are equally downward.
  eligible.sort((a, b) => b.bias - a.bias || b.score - a.score);
  const best = eligible[0];
  return { azimuth: best.azimuth, polar: best.polar };
}

/**
 * Every node a selection should be framed with: itself, the nodes one edge
 * away, and — only while that is still a single node — its siblings, so a leaf
 * never ends up alone in an empty window.
 */
export function focusSet(selected: number, neighbours: number[], siblings: number[] = [], minimum = 2): number[] {
  const picked = [selected];
  const seen = new Set(picked);
  for (const id of neighbours) if (!seen.has(id)) { seen.add(id); picked.push(id); }
  for (const id of siblings) {
    if (picked.length >= minimum) break;
    if (!seen.has(id)) { seen.add(id); picked.push(id); }
  }
  return picked;
}

/** Animation length, with the reduced-motion switch every camera move respects. */
export function focusDuration(reducedMotion: boolean, ms = 780): number {
  return reducedMotion ? 0 : ms;
}

/** Quaternion [x, y, z, w] for a camera at `eye` looking at `target`, no roll. */
export function lookQuaternion(
  eye: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
): [number, number, number, number] {
  let zx = eye.x - target.x, zy = eye.y - target.y, zz = eye.z - target.z;
  const zLength = Math.hypot(zx, zy, zz) || 1;
  zx /= zLength; zy /= zLength; zz /= zLength;
  // x = normalise(worldUp x z); straight down the pole the cross vanishes.
  let xx = zz, xy = 0, xz = -zx;
  let xLength = Math.hypot(xx, xy, xz);
  if (xLength < 1e-6) { xx = 1; xy = 0; xz = 0; xLength = 1; }
  xx /= xLength; xy /= xLength; xz /= xLength;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m00 = xx, m01 = yx, m02 = zx;
  const m10 = xy, m11 = yy, m12 = zy;
  const m20 = xz, m21 = yz, m22 = zz;
  const trace = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / n, qy / n, qz / n, qw / n];
}

/**
 * How strongly a direction reads as "parent above, child below", positive when
 * children are drawn lower on screen, negative when the hierarchy is seen
 * upside down, near zero when it is seen edge-on.
 */
export function downwardness(
  edges: Array<{ parent: FocusSphere; child: FocusSphere }>,
  azimuth: number,
  polar: number,
): number {
  if (!edges.length) return 0;
  const basis = cameraBasis(azimuth, polar);
  let total = 0;
  let magnitude = 0;
  for (const edge of edges) {
    const parentHeight = edge.parent.x * basis.up.x + edge.parent.y * basis.up.y + edge.parent.z * basis.up.z;
    const childHeight = edge.child.x * basis.up.x + edge.child.y * basis.up.y + edge.child.z * basis.up.z;
    // Screen y grows downwards, so a child with a smaller camera height is
    // drawn below its parent — the direction the reading should flow.
    const delta = parentHeight - childHeight;
    total += delta;
    magnitude += Math.abs(delta);
  }
  return magnitude < 1e-9 ? 0 : total / magnitude;
}