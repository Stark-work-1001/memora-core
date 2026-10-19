/**
 * The "nebula" layout for the semantic-relation view.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The 3D view is a port of the AI Coding Dictionary (mattpocock's `dictionary-of-ai-coding`,
 * aicodingdictionary.com). That site bakes its graph geometry at build time: 71 terms sit inside
 * seven overlapping spherical shells ("sections"), and every cross-section link is drawn as a
 * quadratic Bezier that bulges away from the centre of the cloud. Its renderer never runs a force
 * simulation. Memora feeds the same renderer a Markdown projection instead, and the copied graph
 * builder (`vendor/dictionary-graph/src/model/graph.ts:buildNoteGraph`) has no baked coordinates:
 * it relaxes the note with a spring embedder and leaves `edge.control` null. The result on screen
 * is a round cloud of dots joined by straight lines -- recognisably not the reference.
 *
 * This module re-derives the reference geometry from the data Memora already has. The section of a
 * term is already in the graph (`## 分类标题` in the projection becomes `node.section`), so the only
 * things missing are: where each section's shell sits, where each term sits inside its shell, and
 * where each cross-section curve bends.
 *
 * THE THREE RULES, MEASURED (not guessed)
 * ---------------------------------------
 * `runtime/matt-dictionary-graph.json` is the reference site's own baked JSON, extracted from its
 * JS bundle. Every number below comes from that file; `artifacts/p4-matt/reference-rules.json`
 * holds the full statistics and `artifacts/p4-matt/analyze-*.mjs` the scripts that produced them.
 *
 *  1. A term's section owns a sphere: `{centroid, radius}`, and `radius` is exactly the distance
 *     from that centroid to its *furthest* member (measured max/min ratio = 1.0000 in all seven
 *     sections). Shells overlap heavily -- every one of the 21 shell pairs intersects, with the
 *     closest pair overlapping by 8.09 world units -- so the cloud reads as one nebula, not seven
 *     separated balls.
 *  2. A link whose endpoints share a section is **straight**. The reference still stores a control
 *     point, but it is the edge midpoint (largest deviation over 185 same-section edges: 0.00866,
 *     which is exactly the bound of writing the value to two decimals).
 *  3. A link whose endpoints are in **different** sections is a curve, and its control point is
 *
 *        control = midpoint(a, b) + 0.16 * |b - a| * unit(midpoint - centre)
 *
 *     where `centre` is the centre of the whole cloud (the reference JSON sums to (0.01, 0.01,
 *     -0.04), i.e. it was centred on the origin before being written out). Measured over all 358
 *     cross-section edges: the offset/edge-length ratio is 0.16 for every edge (worst deviation
 *     6.0e-5, again two-decimal rounding), and rebuilding the control points from positions alone
 *     reproduces the stored ones with mean error 0.0049 and max error 0.0084 world units -- below
 *     the 0.00866 rounding bound. So this is a *bit-for-bit* reproduction of the generator's rule,
 *     not an approximation of the look.
 *
 *     Lead's brief proposed "the outward component perpendicular to the edge". That family is
 *     close in spirit but is not what the reference did: the offset is radial from the cloud
 *     centre with a component *along* the edge (mean cos(offset, edge direction) = -0.41). Rule 3
 *     above is the exact one, and it is what this module implements.
 *
 * EVERYTHING IS DETERMINISTIC
 * ---------------------------
 * Same input -> bit-identical output. There is no `Math.random`: every pseudo-random decision is
 * drawn from `mulberry32` seeded with a hash of the content (section titles, member slugs). That
 * matters because the graph is rebuilt on every document switch and the arrangement must not
 * reshuffle under the reader.
 *
 * WHAT IS NOT REPRODUCED
 * ----------------------
 * The reference's own centroid coordinates (which sections sit where) are content-specific and are
 * not in the JSON as a rule -- they come from its generator. This module places sections on a
 * noisy ring and then scales all radii until every pair of shells intersects, which reproduces the
 * *structure* (a ring of heavily overlapping shells) rather than the reference's exact numbers.
 * Likewise the reference's seven-colour section palette is replaced by the host's own six-colour
 * palette (see `installNebulaLayout`), because Memora's projection yields at most six categories.
 */

/** A point in the renderer's world space. */
export type Vec3 = [number, number, number];

/** The parts of a node the layout reads. Mirrors `vendor/dictionary-graph/src/model/types.ts`. */
export interface NebulaNode {
  slug: string;
  /** Section index from the projection's level-2 headings; -1 when a term has none. */
  section: number;
  inDegree: number;
  position: Vec3;
}

/** Edges are index pairs plus the Bezier control point this module fills in. */
export interface NebulaEdge {
  source: number;
  target: number;
  control: Vec3 | null;
}

/** The graph shape both `buildNoteGraph` and this module agree on. */
export interface NebulaGraph {
  nodes: NebulaNode[];
  edges: NebulaEdge[];
  sections: { title: string; index: number }[];
}

/** One section's shell: where it sits, how big it is, and who is inside it. */
export interface SectionShell {
  index: number;
  title: string;
  /** Node indices, in graph order. */
  members: number[];
  internalEdges: number;
  crossEdges: number;
  degreeSum: number;
  centroid: Vec3;
  radius: number;
}

/** What a bake did, in numbers a test or the acceptance run can assert on. */
export interface NebulaReport {
  nodes: number;
  edges: number;
  shells: {
    index: number; title: string; members: number;
    centroid: Vec3; radius: number;
    internalEdges: number; crossEdges: number;
    /** Bubble centre to the cloud centre: what "lobes on a ring" is measured by. */
    centreDistance: number;
    /** Member distances from the bubble centre, divided by its radius (the fill profile). */
    radial: { min: number; mean: number; max: number };
    /** Median, over members, of the distance to that member's closest section-mate / radius. */
    nearestNeighbour: number;
    /** Median over ALL member pairs of this section, divided by the radius (a spread, not a gap). */
    memberSpan: number;
  }[];
  /** Global measurements a scale or density regression has to be checked against. */
  geometry: {
    /** Cloud bounding-box side lengths, and the diagonal (the reference is 581 for 71 terms). */
    extent: Vec3;
    diagonal: number;
    /** Mean distance of a bubble centre from the cloud centre (the ring radius). */
    ringRadius: number;
    /** Global nearest-neighbour distances, in world units. */
    nearestNeighbour: { min: number; median: number; max: number };
    /** Median member-to-member distance inside a section vs across sections. */
    withinMedian: number;
    betweenMedian: number;
    /** withinMedian / betweenMedian: below 1 means the sections really are clumps. */
    clumpRatio: number;
    /**
     * How much closer the tightest pair of centres is than the keep-apart floor allows, as a
     * multiple (1 = the floor is met). At 2-4 members per section the overlap requirement and the
     * keep-apart requirement cannot both be met, and this records how far apart the two are rather
     * than letting the report imply both were satisfied.
     */
    crowding: number;
    /** Shell-pair overlaps as fractions of each pair's combined reach (positive = intersecting). */
    shellOverlaps: { min: number; median: number; max: number };
  };
  /** Edges drawn as straight lines (same section, or degenerate). */
  straightEdges: number;
  /** Edges drawn as curves (different sections). */
  curvedEdges: number;
  /** The measured 0.16, exported so a report can be checked against the reference. */
  curveRatio: number;
  /** Smallest (shared volume) pair overlap, in world units; negative would mean separated. */
  minShellOverlap: number;
  shellsAllIntersect: boolean;
  origin: Vec3;
  extent: { min: Vec3; max: Vec3 };
  /** Largest / smallest member distance from its own centroid, divided by that shell's radius. */
  radialRatio: { min: number; max: number };
  /** Closest pair of nodes anywhere in the cloud (reads as a legibility floor). */
  minNodeDistance: number;
  /** Measured |control - midpoint| / |b - a| over every curved edge. */
  controlRatio: { min: number; max: number };
  /** The seed text that makes the bake reproducible. */
  seed: string;
}

// --- the measured reference constants ----------------------------------------

/**
 * Cross-section curve strength: offset / edge length.
 *
 * This is the reference site's own number, recovered from all 358 of its cross-section edges
 * (range 0.15994-0.16006, which is two-decimal rounding around exactly 0.16). Changing it makes
 * the view stop matching the reference, so it is a constant rather than a setting.
 */
export const CURVE_RATIO = 0.16;

/**
 * Section radius per cube-root member: `radius = SECTION_RADIUS_BASE * cbrt(members)`.
 *
 * The reference's seven sections are 52-89 units per cube root of their member count, and their
 * members fill the resulting ball (median member distance 58% of the radius, furthest exactly the
 * radius). A ball of evenly spread points has that same `radius ~ cbrt(n)` growth, so this is the
 * reference's shape expressed at Memora's size: a 2-term section gets a 33-unit shell, a 4-term
 * one 41.
 *
 * The absolute number is the density choice, and it is what separates a nebula from a sparse net.
 * Reference density is 71 terms in a cloud of radius 210, i.e. a median nearest-neighbour gap of
 * 0.28 cloud radii. At 14 terms the same *visual* density needs the two numbers just above.
 */
export const SECTION_RADIUS_BASE = 56;
export const SHELL_MIN_RADIUS = 24;
/** Exponent on the member count: a ball's radius grows as the cube root of what it holds. */
export const SHELL_RADIUS_MEMBER_EXPONENT = 1 / 3;
/**
 * The overlap every pair of shells must reach, as a fraction of the pair's combined radius.
 *
 * This is the reference's defining trait and the one this view has to keep: all 21 of its section
 * pairs intersect, its shallowest pair by 3.8% and its median by 46%. 0.08 reproduces that shape
 * at Memora's scale -- the widest-separated pair is the one set to exactly this, and every other
 * pair then interpenetrates more, which is the same gradient the reference has.
 *
 * Interpenetration is also what makes the cross-section arcs legible: the 0.16 curve rule scales
 * with edge length, so overlapping shells mean long cross-section edges and visibly bowed links.
 */
export const MIN_SHELL_OVERLAP = 0.08;
/**
 * Least distance between two section centres, as a fraction of their combined radius.
 *
 * This is the one place the reference cannot be copied at face value. Its sections hold 6-16
 * terms, so they survive a 71% overlap and still read as seven clumps; a section here holds 2-4,
 * and two of those lying on top of each other would merge into one. So the ring is also required
 * to keep every pair at least this far apart, which is enough for each section's members to be
 * nearer their own centre than the neighbour's. When a graph cannot satisfy both bounds at once,
 * `bakeSections` favours the overlap bound and records the shortfall in the report.
 */
export const MIN_CENTROID_RATIO = 0.42;
/** Vertical jitter of the centres, as a fraction of the ring radius (the reference is nearly flat). */
export const RING_LIFT = 0.25;
/** The keep-out distance between terms, as a fraction of the mean section radius. */
export const NODE_GAP_FACTOR = 0.3;
/**
 * Innermost placement radius, as a fraction of the shell radius.
 *
 * The reference's closest member to its own section centre sits at 0.15-0.33 of the radius: the
 * sections are solid balls, not hollow shells, and that is the single biggest difference between
 * the reference's look and a ring of dots. 0.06 lets the innermost term land near the centre while
 * the placement below still guarantees the outermost touches the surface.
 */
export const SHELL_INNER_FRACTION = 0.06;
/** How strongly a well-connected term is pulled towards its shell's centre. */
export const HUB_PULL = 0.15;
const SEPARATION_ROUNDS = 60;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// --- small vector helpers ----------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleVec = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const distance = (a: Vec3, b: Vec3): number => length(subtract(a, b));

function unit(a: Vec3): Vec3 {
  const size = length(a);
  if (size < 1e-9) return [0, 1, 0];
  return [a[0] / size, a[1] / size, a[2] / size];
}

/** Rotate `v` around `axis` (unit) by `angle`, Rodrigues' formula. */
function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cross: Vec3 = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ];
  return [
    v[0] * cos + cross[0] * sin + axis[0] * dot * (1 - cos),
    v[1] * cos + cross[1] * sin + axis[1] * dot * (1 - cos),
    v[2] * cos + cross[2] * sin + axis[2] * dot * (1 - cos),
  ];
}

/**
 * Deterministic 32-bit PRNG (mulberry32) seeded from the graph's own content.
 *
 * Same idea as the copied graph builder's `seededRandom`: the seed is a string derived from what
 * is being laid out, so the arrangement survives a reload and two runs of the same data agree bit
 * for bit. Nothing here reaches for `Math.random`.
 */
export function seededRandom(seedText: string): () => number {
  let hash = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    hash ^= seedText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable direction for the degenerate "two nodes on top of each other" case. */
function fallbackDirection(i: number, j: number): Vec3 {
  const angle = (i * 2.399963229728653 + j * 1.618033988749895) % (Math.PI * 2);
  return [Math.cos(angle), Math.sin(angle) * 0.35, Math.sin(angle)];
}

// --- 1. shells ---------------------------------------------------------------

/**
 * Group terms into sections and give each section a shell.
 *
 * Section order comes from the projection (its category order), not from the data, so the ring is
 * stable. Terms with no section (a projection with no level-2 heading) become their own shell
 * rather than being scattered, and are placed last.
 *
 * The radius starts as a function of member count -- the reference's radii are ~55-90 units per
 * cube root of member count -- and is then scaled up as one number until *every* pair of shells
 * intersects. Scaling all radii together keeps the relative sizes the reference has, while the
 * single global factor is what guarantees "one nebula, not several balls" for any graph.
 */
export function bakeSections(graph: NebulaGraph): SectionShell[] {
  const titles = new Map(graph.sections.map(section => [section.index, section.title]));
  const grouped = new Map<number, number[]>();
  for (let i = 0; i < graph.nodes.length; i++) {
    const key = graph.nodes[i].section;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(i);
    else grouped.set(key, [i]);
  }
  const keys = [...grouped.keys()].sort((a, b) => (a === -1 ? 1 : 0) - (b === -1 ? 1 : 0) || a - b);
  const shells: SectionShell[] = keys.map(key => ({
    index: key,
    title: titles.get(key) ?? (key < 0 ? '未分类' : '分区 ' + (key + 1)),
    members: grouped.get(key) ?? [],
    internalEdges: 0,
    crossEdges: 0,
    degreeSum: 0,
    centroid: [0, 0, 0],
    radius: 0,
  }));

  // A projection can name a section it puts no terms in (the dictionary projection always ends
  // with an "## 显式层级与学习路径" heading that carries no `### ` terms). Such a section has no
  // shell to place, and giving it one would waste a slot on the ring and shrink every real shell.
  for (let i = shells.length - 1; i >= 0; i--) if (!shells[i].members.length) shells.splice(i, 1);

  const shellOf = new Map<number, SectionShell>();
  for (const shell of shells) for (const member of shell.members) shellOf.set(member, shell);
  for (const edge of graph.edges) {
    const from = shellOf.get(edge.source);
    const to = shellOf.get(edge.target);
    if (!from || !to) continue;
    if (from === to) from.internalEdges++;
    else { from.crossEdges++; to.crossEdges++; }
  }
  for (const shell of shells) {
    for (const member of shell.members) shell.degreeSum += Math.max(0, Math.trunc(graph.nodes[member].inDegree) || 0);
    shell.radius = Math.max(SHELL_MIN_RADIUS,
      SECTION_RADIUS_BASE * Math.pow(Math.max(1, shell.members.length), SHELL_RADIUS_MEMBER_EXPONENT));
  }

  // Section centres sit on ONE NEARLY FLAT RING, in section order.
  //
  // This is the reference's own arrangement, measured: its seven centroids are 72-146 units from
  // the cloud centre, only -14 to +25 off the plane, at intervals that are roughly 60 degrees
  // apart with visible jitter (62.8, 38.2, 53.8, 43.8, 45.6, 53.7, 62.1). A ring is what makes
  // the result read as lobes beside each other rather than one blob with bumps: an orbit camera
  // looks at the ring from the side, so every section keeps its own patch of screen.
  const rand = seededRandom(shells.map(shell => shell.title + ':' + shell.members.length).join('|'));
  const count = shells.length;
  const meanRadius = shells.reduce((sum, shell) => sum + shell.radius, 0) / Math.max(1, count);

  // Equal slots with jitter, capped so no two slots can swap places: the reference's own gaps vary
  // by about a third of a slot either way.
  const angles = shells.map((_, order) => {
    if (count <= 1) return 0;
    const slot = (Math.PI * 2 * order) / count;
    const spread = (Math.PI * 2) / count;
    return slot + (rand() - 0.5) * spread * 0.55;
  });
  const lifts = shells.map(() => (rand() - 0.5) * RING_LIFT);

  /** Distance between the centres of sections i and j on a ring of the given radius. */
  const separation = (i: number, j: number, radius: number): number => {
    if (count <= 1) return 0;
    const chord = 2 * radius * Math.abs(Math.sin((angles[i] - angles[j]) / 2));
    return Math.hypot(chord, (lifts[i] - lifts[j]) * radius);
  };

  // Size the ring so BOTH constraints hold at once:
  //
  //   every pair overlaps   -> separation <= (1 - MIN_SHELL_OVERLAP) * (r_i + r_j)   [upper bound]
  //   every pair separable  -> separation >= MIN_CENTROID_RATIO   * (r_i + r_j)     [lower bound]
  //
  // The two bound different pairs, so a single ring radius can satisfy both only when the ring is
  // uniform enough. The upper bound is what makes the mass interlock (the widest-separated pair
  // sets it); the lower bound keeps the closest pair from collapsing into one lobe. Because the
  // slots are not equally spaced, the ring is solved against the actual chords, not the average.
  const pairReach = (i: number, j: number): number => shells[i].radius + shells[j].radius;
  // For each pair, the ring radius that puts its two centres exactly on the overlap boundary.
  // The pair needing the *smallest* such radius is the one that binds (the widest chord).
  let ringForOverlap = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const reach = pairReach(i, j);
      const chord = separation(i, j, 1);
      if (reach <= 0 || chord < 1e-6) continue;
      ringForOverlap = Math.min(ringForOverlap, ((1 - MIN_SHELL_OVERLAP) * reach) / chord);
    }
  }
  // ... and the largest radius that still keeps the closest pair apart. When the second exceeds
  // the first the two goals conflict; the overlap wins because it is the reference's shape.
  let ringForSeparation = 0;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const reach = pairReach(i, j);
      const chord = separation(i, j, 1);
      if (reach <= 0 || chord < 1e-6) continue;
      ringForSeparation = Math.max(ringForSeparation, (MIN_CENTROID_RATIO * reach) / chord);
    }
  }
  // Use the LARGEST ring that still keeps every pair overlapping: that is maximum separation
  // subject to the overlap rule, so the clumps are as distinguishable as interpenetration allows.
  // `ringForSeparation` is only a diagnostic -- at this member count it cannot also be satisfied,
  // and the shortfall is reported rather than hidden.
  const ringRadius = Number.isFinite(ringForOverlap) && ringForOverlap > 0 ? ringForOverlap : meanRadius;
  // `ringForSeparation` cannot also be satisfied at this member count; it is kept above only so
  // the choice is written down. The shortfall is measured from the final centres in the report.
  shells.forEach((shell, order) => {
    if (count <= 1) { shell.centroid = [0, 0, 0]; return; }
    shell.centroid = [
      Math.cos(angles[order]) * ringRadius,
      lifts[order] * ringRadius,
      Math.sin(angles[order]) * ringRadius,
    ];
  });
  return shells;
}

// --- 2. positions ------------------------------------------------------------

/**
 * The reference's measured radial fill profile: quantile -> (distance / section radius).
 *
 * Read off all 71 terms of the reference graph (artifacts/p4-matt/reference-rules.json holds the
 * per-section ratioMin/ratioMax/meanRatio this was derived from). Its shape -- a member at 0.15 of
 * the radius, the median at 0.58, the furthest at exactly 1.0 -- is what makes a section a solid
 * ball rather than a hollow shell with every member pinned to the surface.
 */
const RADIAL_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.15], [0.1, 0.31], [0.25, 0.4], [0.5, 0.58], [0.75, 0.78], [0.9, 0.97], [1, 1.0],
];

/** Distance/radius at a quantile of the reference's radial profile, linearly interpolated. */
export function radialFraction(quantile: number): number {
  const q = Math.min(1, Math.max(0, quantile));
  for (let i = 1; i < RADIAL_PROFILE.length; i++) {
    const [q1, r1] = RADIAL_PROFILE[i];
    if (q > q1) continue;
    const [q0, r0] = RADIAL_PROFILE[i - 1];
    const span = q1 - q0;
    return span <= 1e-9 ? r1 : r0 + ((q - q0) / span) * (r1 - r0);
  }
  return 1;
}

/** One point of a Fibonacci sphere, the standard even-spacing distribution on a sphere. */
function fibonacciDirection(index: number, count: number): Vec3 {
  const y = count === 1 ? 0 : 1 - (2 * (index + 0.5)) / count;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = GOLDEN_ANGLE * index;
  return [Math.cos(angle) * ring, y, Math.sin(angle) * ring];
}

/**
 * Place every term inside its own shell.
 *
 * Direction: Fibonacci sphere per section, then rotated by a per-section random axis-angle so two
 * sections with the same member count do not line up, and jittered so the spiral does not read as
 * one.
 *
 * Radius: the sections are SOLID BALLS, not hollow shells, and this is the measured difference
 * between the reference's nebula and a ring of dots. Across its own 71 terms, the distance from a
 * term to its section centre divided by that section's radius has quantiles
 *
 *     p0 0.15 | p10 0.31 | p25 0.40 | p50 0.58 | p75 0.78 | p90 0.97 | p100 1.00
 *
 * so mean 0.60, with a member close to the centre and the furthest exactly on the surface.
 * `RADIAL_PROFILE` is that table: members take evenly spaced quantiles of it, which is what makes
 * a two-term section span 0.15..1.00 instead of clustering at the surface. A deterministic jitter
 * breaks the visible ordering, and the section is then rescaled so its outermost member lands
 * exactly on the surface -- the reference's own definition of `radius` (max member distance).
 *
 * A final deterministic pass pushes apart any pair of terms closer than the keep-out distance,
 * including terms from different sections whose shells overlap, and re-clamps each term into its
 * own shell.
 */
export function bakePositions(graph: NebulaGraph, shells: SectionShell[]): void {
  const maxDegree = Math.max(1, ...graph.nodes.map(node => Math.max(0, Math.trunc(node.inDegree) || 0)));
  for (const shell of shells) {
    const members = shell.members;
    const count = members.length;
    if (!count) continue;
    const rand = seededRandom(shell.title + '|' + count + '|' + members.map(index => graph.nodes[index].slug).join(','));
    const axis = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
    const spin = rand() * Math.PI * 2;
    const placed: { at: number; direction: Vec3; q: number }[] = [];
    for (let order = 0; order < count; order++) {
      const base = rotateAround(fibonacciDirection(order, count), axis, spin);
      const jitter: Vec3 = [
        base[0] + (rand() - 0.5) * 0.22,
        base[1] + (rand() - 0.5) * 0.22,
        base[2] + (rand() - 0.5) * 0.22,
      ];
      const at = members[order];
      // Evenly spaced quantiles of the measured radial profile: a two-term section spans its whole
      // range, a six-term one fills it. `count === 1` sits on the surface so a lone term's section
      // radius is exactly its own distance to that surface.
      const quantile = count <= 1 ? 1 : order / (count - 1);
      // A deterministic nudge, at most a quarter of one gap between quantiles, so members ordered
      // by radius do not read as a ladder. Bounded this tightly on purpose: a 2-member section's
      // quantiles are the ends of the profile (0.15 and 1.0), and a wider nudge would drag its
      // innermost member back out towards the surface -- which is exactly the hollow-shell look
      // this profile exists to remove.
      const jittered = Math.min(1, Math.max(0,
        quantile + (rand() - 0.5) * (0.25 / Math.max(1, count - 1))));
      placed.push({ at, direction: unit(jitter), q: radialFraction(jittered) });
    }
    // The outermost member sits exactly on the shell, matching the reference's radius definition.
    const outermost = Math.max(...placed.map(entry => entry.q), 1e-6);
    for (const entry of placed) {
      const radius = shell.radius * (entry.q / outermost);
      graph.nodes[entry.at].position = add(shell.centroid, scaleVec(entry.direction, radius));
    }
  }
  separate(graph, shells);
}

/**
 * Push overlapping terms apart without letting them leave their own shell.
 *
 * The keep-out distance scales with the section radius rather than being a fixed number of world
 * units: a section's radius already grows with how many terms it holds, so `NODE_GAP_FACTOR` of it
 * is the density the reference has at any graph size. Two terms in different sections still get
 * pushed apart here -- their shells overlap, so their terms can too -- but neither is moved out of
 * its own shell, which keeps the section a recognisable ball.
 */
function separate(graph: NebulaGraph, shells: SectionShell[]): void {
  const positions = graph.nodes.map(node => node.position);
  const total = positions.length;
  if (total < 2) return;
  const shellOf = new Map<number, SectionShell>();
  for (const shell of shells) for (const member of shell.members) shellOf.set(member, shell);
  // The keep-out is a VOLUME budget, not a fixed fraction of the radius.
  //
  // A section of radius r holding m terms has that little room per term, so the distance two terms
  // can demand is bounded by the ball's own packing: r * (NODE_GAP_FACTOR / cbrt(m)). Using the
  // mean radius alone (as the first version did) made a 100-term project demand the same gap as a
  // 3-term one, and the pass then shoved every term out to its shell's surface -- the hollow-shell
  // look this layout exists to avoid, reintroduced at exactly the scale real projects run at.
  const meanRadius = shells.reduce((sum, shell) => sum + shell.radius, 0) / Math.max(1, shells.length);
  const meanMembers = shells.reduce((sum, shell) => sum + Math.max(1, shell.members.length), 0)
    / Math.max(1, shells.length);
  // The neighbour search must not be O(n^2) per round: a 400-term project would spend millions of
  // comparisons rebuilding a view that is meant to appear instantly, and an 880-term one would
  // take seconds. A uniform grid at the keep-out cell size finds exactly the pairs that can be
  // too close, and nothing else, so this stays linear in the number of terms.
  const keepOutFor = (index: number): number => {
    const shell = clamping.get(index);
    const members = shell ? Math.max(1, shell.members.length) : meanMembers;
    const radius = shell ? shell.radius : meanRadius;
    return Math.max(0.5, radius * NODE_GAP_FACTOR / Math.cbrt(members));
  };
  // The grid is sized for the widest keep-out any term can ask for, so a cell never misses a
  // neighbour that a term would want to push away from.
  const cell = Math.max(1e-6, meanRadius * NODE_GAP_FACTOR / Math.cbrt(Math.max(1, meanMembers)));
  const cellKey = (at: Vec3): string =>
    Math.floor(at[0] / cell) + ',' + Math.floor(at[1] / cell) + ',' + Math.floor(at[2] / cell);
  const clamping = new Map<number, SectionShell>();
  for (const shell of shells) for (const member of shell.members) clamping.set(member, shell);

  for (let round = 0; round < SEPARATION_ROUNDS; round++) {
    let moved = false;
    // Rebuilding the grid every round is what lets a term move to another cell; the grid is only
    // as expensive as the terms it holds, and the loop settles in a handful of rounds.
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < total; i++) {
      const key = cellKey(positions[i]);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i); else buckets.set(key, [i]);
    }
    // Every unordered pair appears once: a cell against its 13 "greater or equal" neighbours.
    const offsets: [number, number, number][] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz >= 0)))) offsets.push([dx, dy, dz]);
        }
      }
    }
    for (const [key, bucket] of buckets) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (const [dx, dy, dz] of offsets) {
        const other = buckets.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
        if (!other) continue;
        for (const i of bucket) {
          for (const j of other) {
            if (i === j) continue;
            if (dx === 0 && dy === 0 && dz === 0 && j < i) continue;
            const local = Math.min(keepOutFor(i), keepOutFor(j));
            const delta = subtract(positions[i], positions[j]);
            const span = length(delta);
            if (span >= local) continue;
            const push = (local - span) / 2;
            const direction = span > 1e-6 ? scaleVec(delta, 1 / span) : fallbackDirection(i, j);
            positions[i] = add(positions[i], scaleVec(direction, push));
            positions[j] = add(positions[j], scaleVec(direction, -push));
            moved = true;
          }
        }
      }
    }
    for (let i = 0; i < total; i++) {
      const shell = clamping.get(i);
      if (!shell) continue;
      const offset = subtract(positions[i], shell.centroid);
      const reach = length(offset);
      const limit = shell.radius * 0.995;
      if (reach > limit) positions[i] = add(shell.centroid, scaleVec(offset, limit / reach));
    }
    if (!moved) break;
  }
  graph.nodes.forEach((node, index) => { node.position = positions[index]; });
}

// --- 3. edges ----------------------------------------------------------------

/** Centre of the whole cloud: the point cross-section curves bulge away from. */
export function centreOf(graph: NebulaGraph): Vec3 {
  if (!graph.nodes.length) return [0, 0, 0];
  let sum: Vec3 = [0, 0, 0];
  for (const node of graph.nodes) sum = add(sum, node.position);
  return scaleVec(sum, 1 / graph.nodes.length);
}

/**
 * Write every edge's control point: straight inside a section, curved across sections.
 *
 * Same section -> `null`, which the renderer already turns into the straight line through the
 * midpoint (`vendor/dictionary-graph/src/render/scene.ts:rebuildEdgeGeometry`). Cross section ->
 * the midpoint pushed `CURVE_RATIO * |b - a|` units away from the cloud centre. Both branches are
 * the reference's measured behaviour (see the module comment).
 *
 * A cross-section edge whose midpoint sits on the centre has no outward direction; it falls back
 * to a perpendicular so the curve stays visible instead of collapsing to a line. The reference
 * never hits this case -- its smallest midpoint radius is ~40 units -- so the fallback is an
 * equivalence guard, not part of the reproduced rule.
 */
export function bakeControls(graph: NebulaGraph, origin: Vec3): { straightEdges: number; curvedEdges: number } {
  let straightEdges = 0;
  let curvedEdges = 0;
  for (const edge of graph.edges) {
    const from = graph.nodes[edge.source];
    const to = graph.nodes[edge.target];
    if (!from || !to || from.section === to.section) { edge.control = null; straightEdges++; continue; }
    const a = from.position;
    const b = to.position;
    const span = distance(a, b);
    if (span < 1e-6) { edge.control = null; straightEdges++; continue; }
    const midpoint: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    let outward = subtract(midpoint, origin);
    if (length(outward) < 1e-6) {
      const direction = unit(subtract(b, a));
      let perpendicular: Vec3 = [direction[1], -direction[0], 0];
      if (length(perpendicular) < 1e-6) perpendicular = [-direction[2], 0, direction[0]];
      outward = perpendicular;
    }
    const push = scaleVec(unit(outward), CURVE_RATIO * span);
    edge.control = add(midpoint, push);
    curvedEdges++;
  }
  return { straightEdges, curvedEdges };
}

// --- 4. one call -------------------------------------------------------------

/** Bake shells, positions and control points, and measure what the bake produced. */
export function bakeNebula(graph: NebulaGraph): NebulaReport {
  const shells = bakeSections(graph);
  bakePositions(graph, shells);
  const origin = centreOf(graph);
  const { straightEdges, curvedEdges } = bakeControls(graph, origin);

  const extent = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (const node of graph.nodes) {
    for (let axis = 0; axis < 3; axis++) {
      extent.min[axis] = Math.min(extent.min[axis], node.position[axis]);
      extent.max[axis] = Math.max(extent.max[axis], node.position[axis]);
    }
  }
  if (!graph.nodes.length) { extent.min = [0, 0, 0]; extent.max = [0, 0, 0]; }

  let minShellOverlap = Infinity;
  for (let i = 0; i < shells.length; i++) {
    for (let j = i + 1; j < shells.length; j++) {
      minShellOverlap = Math.min(minShellOverlap,
        shells[i].radius + shells[j].radius - distance(shells[i].centroid, shells[j].centroid));
    }
  }
  if (!Number.isFinite(minShellOverlap)) minShellOverlap = 0;

  let radialMin = Infinity;
  let radialMax = 0;
  for (const shell of shells) {
    if (shell.radius <= 0) continue;
    for (const member of shell.members) {
      const ratio = distance(graph.nodes[member].position, shell.centroid) / shell.radius;
      radialMin = Math.min(radialMin, ratio);
      radialMax = Math.max(radialMax, ratio);
    }
  }
  if (!Number.isFinite(radialMin)) radialMin = 0;

  let minNodeDistance = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let j = i + 1; j < graph.nodes.length; j++) {
      minNodeDistance = Math.min(minNodeDistance, distance(graph.nodes[i].position, graph.nodes[j].position));
    }
  }
  if (!Number.isFinite(minNodeDistance)) minNodeDistance = 0;

  let controlMin = Infinity;
  let controlMax = 0;
  for (const edge of graph.edges) {
    if (!edge.control) continue;
    const from = graph.nodes[edge.source];
    const to = graph.nodes[edge.target];
    if (!from || !to) continue;
    const midpoint: Vec3 = [
      (from.position[0] + to.position[0]) / 2,
      (from.position[1] + to.position[1]) / 2,
      (from.position[2] + to.position[2]) / 2,
    ];
    const ratio = distance(edge.control, midpoint) / Math.max(1e-9, distance(from.position, to.position));
    controlMin = Math.min(controlMin, ratio);
    controlMax = Math.max(controlMax, ratio);
  }
  if (!Number.isFinite(controlMin)) controlMin = 0;

  // Per-shell fill profile and the global density numbers the report has to expose. "Is it a
  // nebula?" is a question about these ratios, not about any single coordinate.
  const median = (values: number[]): number => {
    if (!values.length) return 0;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.floor((ordered.length - 1) / 2)];
  };
  const shellStats = shells.map(shell => {
    const distances = shell.members.map(member => distance(graph.nodes[member].position, shell.centroid));
    // Two different "distance between members" statistics, kept apart on purpose:
    //  - nearestNeighbour: for each member, the closest OTHER member of the same section, then the
    //    median of those. This is the one comparable to the reference's nn_median / radius
    //    (0.32-0.59) and to the global nearest-neighbour figure.
    //  - memberSpan: the median over every pair of members. It is a spread, not a gap, and for a
    //    two-member section it coincides with nearestNeighbour -- which is why reporting only one
    //    number made the two look like the same measurement.
    const memberGap: number[] = [];
    for (let i = 0; i < shell.members.length; i++) {
      let closest = Infinity;
      for (let j = 0; j < shell.members.length; j++) {
        if (i === j) continue;
        closest = Math.min(closest,
          distance(graph.nodes[shell.members[i]].position, graph.nodes[shell.members[j]].position));
      }
      if (Number.isFinite(closest)) memberGap.push(closest);
    }
    const pairs: number[] = [];
    for (let i = 0; i < shell.members.length; i++) {
      for (let j = i + 1; j < shell.members.length; j++) {
        pairs.push(distance(graph.nodes[shell.members[i]].position, graph.nodes[shell.members[j]].position));
      }
    }
    const mean = distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : 0;
    return {
      index: shell.index,
      title: shell.title,
      members: shell.members.length,
      centroid: shell.centroid,
      radius: shell.radius,
      internalEdges: shell.internalEdges,
      crossEdges: shell.crossEdges,
      centreDistance: distance(shell.centroid, origin),
      radial: {
        min: distances.length ? Math.min(...distances) / Math.max(1e-9, shell.radius) : 0,
        mean: mean / Math.max(1e-9, shell.radius),
        max: distances.length ? Math.max(...distances) / Math.max(1e-9, shell.radius) : 0,
      },
      nearestNeighbour: memberGap.length ? median(memberGap) / Math.max(1e-9, shell.radius) : 0,
      memberSpan: pairs.length ? median(pairs) / Math.max(1e-9, shell.radius) : 0,
    };
  });
  const sections = [...new Set(graph.nodes.map(node => node.section))];
  const within: number[] = [];
  const between: number[] = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    for (let j = i + 1; j < graph.nodes.length; j++) {
      (sections.length > 1 && graph.nodes[i].section === graph.nodes[j].section ? within : between)
        .push(distance(graph.nodes[i].position, graph.nodes[j].position));
    }
  }
  const nearest: number[] = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    let closest = Infinity;
    for (let j = 0; j < graph.nodes.length; j++) if (i !== j) {
      closest = Math.min(closest, distance(graph.nodes[i].position, graph.nodes[j].position));
    }
    if (Number.isFinite(closest)) nearest.push(closest);
  }
  const side: Vec3 = [extent.max[0] - extent.min[0], extent.max[1] - extent.min[1], extent.max[2] - extent.min[2]];
  // Overlap of every shell pair, as a fraction of the pair's combined reach.
  const shellOverlaps: number[] = [];
  for (let i = 0; i < shells.length; i++) {
    for (let j = i + 1; j < shells.length; j++) {
      const reach = shells[i].radius + shells[j].radius;
      if (reach <= 0) continue;
      shellOverlaps.push((reach - distance(shells[i].centroid, shells[j].centroid)) / reach);
    }
  }
  const withinMedian = median(within);
  const betweenMedian = median(between);

  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    shells: shellStats,
    geometry: {
      extent: side,
      diagonal: length(side),
      ringRadius: shells.length
        ? shells.reduce((sum, shell) => sum + distance(shell.centroid, origin), 0) / shells.length : 0,
      nearestNeighbour: {
        min: nearest.length ? Math.min(...nearest) : 0,
        median: median(nearest),
        max: nearest.length ? Math.max(...nearest) : 0,
      },
      withinMedian,
      betweenMedian,
      clumpRatio: betweenMedian > 0 ? withinMedian / betweenMedian : 0,
      // How much tighter the closest pair of centres is than the keep-apart floor asks for: 1
      // means the floor is met, 2 means it is half as far apart as it should be. At 2-4 members
      // per section the overlap rule and this floor genuinely conflict, so the number is reported
      // rather than one of the two being quietly dropped.
      crowding: (() => {
        let worst = 1;
        for (let i = 0; i < shells.length; i++) {
          for (let j = i + 1; j < shells.length; j++) {
            const reach = shells[i].radius + shells[j].radius;
            const spread = distance(shells[i].centroid, shells[j].centroid);
            if (reach <= 0 || spread < 1e-9) continue;
            worst = Math.max(worst, (MIN_CENTROID_RATIO * reach) / spread);
          }
        }
        return worst;
      })(),
      shellOverlaps: {
        min: shellOverlaps.length ? Math.min(...shellOverlaps) : 0,
        median: median(shellOverlaps),
        max: shellOverlaps.length ? Math.max(...shellOverlaps) : 0,
      },
    },
    straightEdges,
    curvedEdges,
    curveRatio: CURVE_RATIO,
    minShellOverlap,
    shellsAllIntersect: minShellOverlap > 0,
    origin,
    extent,
    radialRatio: { min: radialMin, max: radialMax },
    minNodeDistance,
    controlRatio: { min: controlMin, max: controlMax },
    seed: graph.sections.map(section => section.title).join('|') + '#' + graph.nodes.map(node => node.slug).join('|'),
  };
}

// --- 5. the host seam --------------------------------------------------------

/**
 * What `installNebulaLayout` needs from the copied app. Deliberately the *public* instance
 * methods, exactly like `graph-look.ts` and `brain-focus.ts` do: `vendor/**` stays unedited and
 * the seam is the same one the app's own toolbar uses.
 */
export interface NebulaScene {
  setGraph(graph: NebulaGraph, index: unknown): void;
}

export interface NebulaHost {
  graph: NebulaGraph;
  index: unknown;
  scene: NebulaScene | null;
  labels: NebulaScene | null;
  /** The copied app's "positions to restore when the network layout is chosen again". */
  originalPositions: Vec3[];
  setSectionColors?(enabled: boolean): void;
  /** Live state of the section-colour switch; `installNebulaLayout` keeps it in sync. */
  readonly sectionColors?: boolean;
  frameAll?(keepOrientation: boolean, ms?: number): void;
  setLayout?(id: string): void;
  setGraph?(graph: NebulaGraph): void;
}

/** Handed back to the shell so the acceptance run can read what the bake produced. */
export interface NebulaSeam {
  readonly report: NebulaReport | null;
  /** Re-bake the current graph and rebuild the host's scene from it. */
  rebake(): NebulaReport | null;
}

/**
 * Bake the app's current graph and make the host draw it.
 *
 * Order matters: the positions and control points are written into the graph the host already
 * holds, then the host's own `setGraph` is called on its scene and label layer so every mesh,
 * every line vertex and every label anchor is rebuilt from the baked coordinates. The camera is
 * re-framed last, because the cloud just changed size.
 *
 * Two of the host's own transitions are wrapped rather than replaced:
 *
 *  - `setGraph` (a document switch, or the preview loading) is baked immediately after the host
 *    has parsed the new note, so a reader never sees the spring-embedder arrangement.
 *  - `setLayout` resets every edge control to `null` by design (its other two layouts are grids
 *    and shells of dots). Coming back to the network layout must restore the curves, or the view
 *    would quietly lose its arcs after one visit to the layout picker.
 */
export function installNebulaLayout(host: NebulaHost, options: { sectionColors?: boolean } = {}): NebulaSeam {
  const state: { report: NebulaReport | null } = { report: null };
  const sectionColors = options.sectionColors !== false;

  /**
   * Section colour is how the nebula is read: the shells are the whole point, and at rest the
   * links are deliberately faint (see `graph-look.ts`). It is therefore on by default here, not
   * left to a switch the reader has to find first. The host owns the actual colouring -- its own
   * six-colour palette, chosen per section index -- so the toolbar's switch keeps working and
   * turning it off still turns it off. This only sets the initial state.
   *
   * The host's own `setSectionColors` returns nothing and its scene keeps the flag private, so the
   * state a toolbar button has to reflect is recorded here, around the call Memora makes. That
   * keeps the button and the scene from ever disagreeing, including after a re-bake.
   */
  const colorState = { on: false };
  const setHostSectionColors = host.setSectionColors?.bind(host);
  if (setHostSectionColors) {
    host.setSectionColors = (enabled: boolean): void => { colorState.on = enabled; setHostSectionColors(enabled); };
    Object.defineProperty(host, 'sectionColors', { configurable: true, get: () => colorState.on });
  }
  const applySectionColors = (): void => { if (sectionColors && !colorState.on) host.setSectionColors?.(true); };

  const rebake = (): NebulaReport | null => {
    const graph = host.graph;
    if (!graph || !graph.nodes.length) return null;
    const report = bakeNebula(graph);
    // The layout picker restores from this copy; it has to hold the baked positions, not the
    // spring-embedder ones the host captured when it parsed the note.
    host.originalPositions = graph.nodes.map(node => [...node.position] as Vec3);
    host.scene?.setGraph(graph, host.index);
    host.labels?.setGraph(graph, host.index);
    applySectionColors();
    host.frameAll?.(false, 0);
    state.report = report;
    return report;
  };

  const setLayout = host.setLayout?.bind(host);
  if (setLayout) host.setLayout = (id: string): void => { setLayout(id); if (id === 'network') rebake(); };
  const setGraph = host.setGraph?.bind(host);
  if (setGraph) host.setGraph = (graph: NebulaGraph): void => { setGraph(graph); rebake(); };

  // The graph arrives asynchronously (the projection is fetched after start() resolves), so the
  // first bake happens on the host's own setGraph call rather than here. Baking an empty graph
  // now and relying on a later call would leave the reader looking at the spring layout.
  if (host.graph?.nodes?.length) rebake();
  return { get report() { return state.report; }, rebake };
}
