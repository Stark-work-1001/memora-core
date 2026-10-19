/**
 * Browser glue for `edge-flex.ts`: makes the three renderers' links flex with the camera.
 *
 * The maths lives in edge-flex.ts and is unit tested. This file only knows how to reach each
 * renderer's geometry, and it is deliberately defensive: every accessor is checked, and a renderer
 * that cannot be reached simply gets no deformation (reported by `stats()`) instead of throwing and
 * taking the whole brain view down.
 *
 * WHY A SHADER PATCH FOR THE OUTLINE AND A BUFFER REWRITE FOR THE DICTIONARY
 * ------------------------------------------------------------------------
 * - dictionary/matt: the resting layer is a plain `LineSegments` whose positions are baked in a
 *   Float32Array by the vendor. There is no per-vertex control point to feed a shader, and the
 *   vendor's own `rebuildEdgeGeometry` is private. So the buffer is rewritten from the same
 *   quadratic sampling the vendor uses, on a throttled tick. Cost is O(edges x 14 segments) and
 *   only runs when the camera has actually turned.
 * - outline: both layers are instanced ShaderMaterials whose per-instance control point is an
 *   attribute. Their `vertexShader` is a public string on a public three.js material, and
 *   `cameraPosition` is a built-in three.js uniform, so the bend is computed on the GPU: zero CPU
 *   work per frame at any graph size. The vendor file is not edited -- only the material instance
 *   the renderer already exposes.
 */
import type { PerspectiveCamera } from 'three';
import {
  angleBetween, cameraForward, flexControl, updateInterval, type FlexEdge, type Vec3,
} from './edge-flex';

/** What a flex installer reports, so the acceptance run can prove the deformation happened. */
export interface FlexStats {
  /** Which renderer this installer drives. */
  kind: 'dictionary' | 'outline';
  /** Links whose control point was rewritten (dictionary) or that the shader now bends (outline). */
  links: number;
  /** Rewrites performed since install. Zero for the outline, whose bend is per-frame on the GPU. */
  updates: number;
  /** Milliseconds spent in the last rewrite (dictionary only). */
  lastUpdateMs: number;
  /** Mean and maximum facing factor over the links at the last update (dictionary only). */
  facing: { mean: number; max: number };
  /** True when the last attempt found nothing it could reach. */
  unreachable: boolean;
  /** Camera-direction change (radians) that triggers a rewrite. */
  thresholdRadians: number;
  /** Minimum milliseconds between rewrites. */
  intervalMs: number;
  /** outline only: how many links each patched shader layer drives. */
  layers?: { hierarchy: number; curves: number };
}

export interface FlexSeam {
  readonly stats: FlexStats;
  /** Rewrite now, regardless of the throttle (used by the acceptance run). */
  refresh(): void;
  /**
   * Stop consuming frames without tearing the layer down.
   *
   * This exists because a benchmark needs an honest "off": disposing the layer and measuring again
   * would compare two different programs, and a flag checked *inside* the tick would still pay the
   * per-frame camera read. Pausing cancels the rAF, so the stopped state really is stopped.
   */
  pause(): void;
  resume(): void;
  dispose(): void;
}

/** A host the dictionary installer needs: the copied app, described by public fields. */
export interface DictionaryFlexHost {
  graph: { nodes: Array<{ position: [number, number, number]; slug: string }>; edges: Array<{ source: number; target: number }> };
  camera: { camera: PerspectiveCamera };
  scene: {
    scene: unknown;
    edges: unknown;
    hot?: unknown;
  } | null;
  /** Public on the copied app; empty when nothing is selected. */
  readonly currentSlug?: string | null;
}

/**
 * Rewrite the copied dictionary renderer's link buffers on every camera turn.
 *
 * `CURVE_SEGMENTS` is the vendor's constant (14). It is read back from the geometry — the existing
 * buffer length divided by the edge count — rather than hard-coded, so a future vendored change to
 * the segment count cannot silently misalign the buffer.
 */
export function installDictionaryFlex(host: DictionaryFlexHost): FlexSeam {
  const state = {
    updates: 0, lastUpdateMs: 0, links: 0, unreachable: false,
    facingMean: 0, facingMax: 0,
  };
  let lastView: Vec3 | null = null;
  let lastAt = -1e9;
  let frame = 0;
  let disposed = false;
  let paused = false;
  let threshold = 0.012; // ~0.7 degrees of camera movement is enough to matter

  /** The three.js objects, reached through the host's public `scene` field. */
  const layers = (): Array<{ geometry?: unknown }> => {
    const scene = host.scene as { edges?: unknown; hot?: unknown } | null;
    return [scene?.edges, scene?.hot].filter(Boolean) as Array<{ geometry?: unknown }>;
  };

  const segmentsOf = (count: number, edges: number): number => {
    if (edges <= 0) return 14;
    const per = count / edges / 2;
    return Number.isFinite(per) && per >= 1 ? Math.round(per) : 14;
  };

  const rewrite = (): void => {
    const scene = host.scene as { edges?: any; hot?: any } | null;
    const graph = host.graph;
    if (!scene || !scene.edges || !graph || !graph.edges.length) { state.unreachable = true; return; }
    const view = cameraForward(host.camera?.camera);
    const started = performance.now();
    const edges: FlexEdge[] = graph.edges.map(edge => ({
      a: vec(graph.nodes[edge.source]?.position),
      b: vec(graph.nodes[edge.target]?.position),
      control: controlOf(host, edge),
    }));

    const selected = selectedIndex(host);
    // The resting layer covers every link, in graph order.
    const resting = scene.edges;
    const restingAttribute = resting?.geometry?.getAttribute?.('position');
    if (!restingAttribute) { state.unreachable = true; return; }
    const segments = segmentsOf(restingAttribute.count, edges.length);
    writeEdges(restingAttribute, edges, edges.map((_, index) => index), segments, view);

    // The emphasis layer redraws only the links touching the selection, also in graph order.
    const hot = scene.hot;
    const hotAttribute = hot?.geometry?.getAttribute?.('position');
    if (hotAttribute && hotAttribute.count > 0 && selected >= 0) {
      const incident: number[] = [];
      edges.forEach((_, index) => {
        const edge = graph.edges[index];
        if (edge.source === selected || edge.target === selected) incident.push(index);
      });
      const hotSegments = segmentsOf(hotAttribute.count, Math.max(1, incident.length));
      if (incident.length && hotSegments === segments) {
        writeEdges(hotAttribute, edges, incident, segments, view);
      }
    }

    // Deliberately NO forced render here.
    //
    // An earlier version called `scene.update()` to make the rewrite visible immediately. That is a
    // whole extra WebGL frame, and it doubled the cost of every frame the camera was turning -- the
    // acceptance run caught it (p95 +21 ms on 24 links). It is also redundant: this rewrite only
    // fires when the camera has actually turned, and on exactly those frames the app's own loop is
    // already inside `draw()` and will call `scene.update()` itself. The buffer is picked up by
    // that frame. When the camera is still, nothing calls us, so there is no frame to miss.
    let sum = 0, max = 0;
    for (const edge of edges) {
      const facing = Math.abs(dot(unit(sub(edge.b, edge.a)), unit(view)));
      sum += facing; max = Math.max(max, facing);
    }
    state.links = edges.length;
    state.updates += 1;
    state.facingMean = edges.length ? sum / edges.length : 0;
    state.facingMax = max;
    state.lastUpdateMs = performance.now() - started;
    state.unreachable = false;
  };

  const tick = (): void => {
    if (disposed) return;
    frame = requestAnimationFrame(tick);
    const view = cameraForward(host.camera?.camera);
    const moved = lastView ? angleBetween(lastView, view) : Math.PI;
    const due = performance.now() - lastAt;
    const vertices = vertexCount(host);
    const interval = updateInterval(vertices);
    threshold = vertices > 12000 ? 0.03 : 0.012;
    if (moved < threshold || due < interval) return;
    rewrite();
    lastView = view;
    lastAt = performance.now();
  };
  frame = requestAnimationFrame(tick);

  return {
    get stats(): FlexStats {
      return {
        kind: 'dictionary', links: state.links, updates: state.updates,
        lastUpdateMs: state.lastUpdateMs,
        facing: { mean: state.facingMean, max: state.facingMax },
        unreachable: state.unreachable, thresholdRadians: threshold,
        intervalMs: updateInterval(vertexCount(host)),
      };
    },
    /**
     * Rewrite now, ignoring the throttle. Used by the acceptance run and by anything that changes
     * the camera outside the animation loop; it does not render, because the caller's next frame
     * will (see the comment in `rewrite`).
     */
    refresh(): void { rewrite(); lastView = cameraForward(host.camera?.camera); lastAt = performance.now(); },
    pause(): void {
      if (paused) return;
      paused = true;
      cancelAnimationFrame(frame);
      frame = 0;
    },
    resume(): void {
      if (!paused || disposed) return;
      paused = false;
      lastView = cameraForward(host.camera?.camera);
      lastAt = performance.now();
      frame = requestAnimationFrame(tick);
    },
    dispose(): void { disposed = true; cancelAnimationFrame(frame); },
  };
}

function vec(position: [number, number, number] | undefined): Vec3 {
  return position ? { x: position[0], y: position[1], z: position[2] } : { x: 0, y: 0, z: 0 };
}
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (a: Vec3): Vec3 => {
  const size = Math.hypot(a.x, a.y, a.z);
  return size < 1e-9 ? { x: 0, y: 1, z: 0 } : { x: a.x / size, y: a.y / size, z: a.z / size };
};

/** The layout's own control point for one edge, read defensively. */
function controlOf(host: DictionaryFlexHost, edge: { source: number; target: number }): Vec3 | null {
  const raw = (edge as { control?: [number, number, number] | null }).control;
  return Array.isArray(raw) && raw.length === 3 ? { x: raw[0], y: raw[1], z: raw[2] } : null;
}

/** Which node is selected, derived from the public `currentSlug` rather than a private field. */
function selectedIndex(host: DictionaryFlexHost): number {
  const slug = host.currentSlug;
  if (!slug) return -1;
  return host.graph.nodes.findIndex(node => node.slug === slug);
}

function vertexCount(host: DictionaryFlexHost): number {
  const scene = host.scene as { edges?: any } | null;
  const attribute = scene?.edges?.geometry?.getAttribute?.('position');
  return attribute ? attribute.count : 0;
}

/**
 * Write the quadratic sampling of one set of links into a position attribute.
 *
 * The vertex layout is the vendor's: for every link, `segments` pairs of vertices, where pair k
 * holds sample(k) then sample(k + 1) (sample(0) being the source position). Keeping that layout is
 * what lets the same buffer serve both the resting `LineSegments` and the selected-link layer.
 */
function writeEdges(
  attribute: { array: ArrayLike<number>; count: number; needsUpdate: boolean },
  edges: FlexEdge[],
  order: number[],
  segments: number,
  view: Vec3,
): void {
  const array = attribute.array as Float32Array;
  for (let slot = 0; slot < order.length; slot++) {
    const edge = edges[order[slot]];
    const control = flexControl(edge, view).control;
    const base = slot * segments * 2 * 3;
    let px = edge.a.x, py = edge.a.y, pz = edge.a.z;
    for (let step = 1; step <= segments; step++) {
      const t = step / segments, u = 1 - t;
      const x = u * u * edge.a.x + 2 * u * t * control.x + t * t * edge.b.x;
      const y = u * u * edge.a.y + 2 * u * t * control.y + t * t * edge.b.y;
      const z = u * u * edge.a.z + 2 * u * t * control.z + t * t * edge.b.z;
      const offset = base + (step - 1) * 6;
      array[offset] = px; array[offset + 1] = py; array[offset + 2] = pz;
      array[offset + 3] = x; array[offset + 4] = y; array[offset + 5] = z;
      px = x; py = y; pz = z;
    }
  }
  attribute.needsUpdate = true;
}

// --- outline -----------------------------------------------------------------

/** The outline renderer, described by the public three.js objects it holds. */
export interface OutlineFlexHost {
  rendererRef: {
    edges?: { mesh?: { material?: unknown; geometry?: { instanceCount?: number } } };
    links?: { group?: { children?: Array<{ material?: unknown; geometry?: { instanceCount?: number } }> } };
    requestFrame?(): void;
  };
}

/**
 * Bend the outline's two instanced link layers in their vertex shaders.
 *
 * The shader source is REPLACED on the material instance at runtime. That is a public three.js
 * property (`ShaderMaterial.vertexShader`), the vendor file is untouched, and the replacement is
 * written out here in full so it can be reviewed and diffed: it is the vendor's own program plus
 * one bend block.
 */
export function installOutlineFlex(host: OutlineFlexHost): FlexSeam {
  const renderer = host.rendererRef;
  const patched: string[] = [];
  let links = 0;

  const patch = (material: any, source: string, name: string): void => {
    if (!material || typeof material !== 'object' || material.__memoraFlex === source) return;
    material.vertexShader = source;
    material.__memoraFlex = source;
    material.needsUpdate = true;
    patched.push(name);
  };

  const edgeMaterial = (renderer.edges?.mesh as { material?: any } | undefined)?.material;
  const linkMaterials = (renderer.links?.group?.children ?? []).map(child => child.material).filter(Boolean) as any[];
  const curveMaterial = linkMaterials[0];
  const arrowMaterial = linkMaterials[1];

  patch(edgeMaterial, HIERARCHY_EDGE_VERTEX, 'edges');
  patch(curveMaterial, CURVED_LINK_VERTEX, 'links');
  if (arrowMaterial && typeof arrowMaterial.vertexShader === 'string') {
    // The arrowhead is a separate cone mesh whose position is set on the CPU. Bending it in the
    // shader would detach it from the curve, so it is left exactly as the vendor draws it; the
    // curve it caps bends around it by at most the bow, which at 0.18 of the link is a few pixels
    // at typical zoom. Reported honestly rather than silently half-done.
    patched.push('arrows:left-unbent');
  }
  // What is actually bent here: BOTH instanced layers. The hierarchy layer carries every parent ->
  // child link; the curve layer carries the association/note links, which on a projection with no
  // associations is legitimately zero. Reporting only the curve count made a working hierarchy flex
  // look like "0 links bent", so both are counted and named.
  const hierarchyLinks = (renderer.edges?.mesh?.geometry?.instanceCount ?? 0) as number;
  const curveLinks = (renderer.links?.group?.children?.[0]?.geometry?.instanceCount ?? 0) as number;
  links = hierarchyLinks + curveLinks;
  renderer.requestFrame?.();

  return {
    get stats(): FlexStats {
      return {
        kind: 'outline', links, updates: 0, lastUpdateMs: 0,
        facing: { mean: 0, max: 0 }, unreachable: patched.length === 0,
        thresholdRadians: 0, intervalMs: 0,
        // Named per layer so the report cannot imply the hierarchy edges were skipped.
        layers: {hierarchy: hierarchyLinks, curves: curveLinks},
      };
    },
    refresh(): void {
      for (const material of [edgeMaterial, curveMaterial]) {
        if (material && material.__memoraFlex) material.needsUpdate = true;
      }
      renderer.requestFrame?.();
    },
    // The GPU path has no tick to pause: the bend is part of the shader, so "paused" would mean
    // restoring the vendor programs. Nothing calls these on this renderer; they exist to keep the
    // seam honest about its shape.
    pause(): void { /* no per-frame work to stop */ },
    resume(): void { /* no per-frame work to start */ },
    dispose(): void { /* the shader stays; there is nothing to tear down at 60 fps */ },
  };
}

/**
 * The bend, in GLSL. Three terms, identical in both programs and in `edge-flex.ts`:
 *
 *   `facing`  = |axis . view|
 *   `side`    = normalize(cross(axis, view))   -- stays in the screen plane
 *   `bow`     = len * (BASE + FACING * facing^2)
 *
 * `BASE` 0.03 and `FACING` 0.18 match the TypeScript constants; a unit test asserts they agree.
 */
const FLEX_GLSL = /* glsl */ `
  const float MEMORA_BASE_BOW = 0.03;
  const float MEMORA_FACING_BOW = 0.18;
  vec3 memoraControl(vec3 a, vec3 b) {
    vec3 axis = b - a;
    float L = length(axis);
    if (L < 1e-5) return (a + b) * 0.5;
    vec3 d = axis / L;
    vec3 view = normalize(cameraPosition - (a + b) * 0.5);
    float facing = clamp(abs(dot(d, view)), 0.0, 1.0);
    vec3 side = cross(d, view);
    side = length(side) > 1e-5 ? normalize(side) : normalize(cross(d, vec3(0.0, 1.0, 0.0)));
    return (a + b) * 0.5 + side * L * (MEMORA_BASE_BOW + MEMORA_FACING_BOW * facing * facing);
  }
  vec3 memoraBezier(vec3 a, vec3 c, vec3 b, float t) {
    float u = 1.0 - t;
    return u * u * a + 2.0 * u * t * c + t * t * b;
  }
  vec3 memoraTangent(vec3 a, vec3 c, vec3 b, float t) {
    return 2.0 * (1.0 - t) * (c - a) + 2.0 * t * (b - c);
  }
`;

const HIERARCHY_EDGE_VERTEX = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute float iRadius;
attribute vec4 iColor;
attribute float iDash;
uniform float uPixelScale;
uniform float uMinPixels;
varying vec4 vColor;
varying float vAlong;
varying float vDash;
varying float vDepth;
${FLEX_GLSL}
void main() {
  vec3 control = memoraControl(iStart, iEnd);
  float t = position.y + 0.5;
  vec3 centre = memoraBezier(iStart, control, iEnd, t);
  vec3 tangent = memoraTangent(iStart, control, iEnd, t);
  vec3 d = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  vec3 ref = abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 a = normalize(cross(d, ref));
  vec3 b = cross(d, a);
  float depth = max(1.0, -(modelViewMatrix * vec4(centre, 1.0)).z);
  float minR = 0.5 * uMinPixels * depth * uPixelScale;
  float r = max(iRadius, minR);
  vColor = vec4(iColor.rgb, iColor.a * clamp(iRadius / max(minR, 1e-4), 0.35, 1.0));
  vAlong = t * length(iEnd - iStart);
  vDash = iDash;
  vDepth = depth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(centre + (a * position.x + b * position.z) * r, 1.0);
}`;

const CURVED_LINK_VERTEX = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iControl;
attribute vec3 iEnd;
attribute float iRadius;
attribute vec4 iColor;
attribute float iDash;
attribute float iLength;
uniform float uPixelScale;
uniform float uMinPixels;
varying vec4 vColor;
varying float vAlong;
varying float vDash;
varying float vDepth;
${FLEX_GLSL}
void main() {
  // The layout's own control point is kept as the resting shape; the camera-relative bow is added
  // in the screen plane on top of it, so a matt-style arc does not lose its authored direction.
  vec3 control = iControl + (memoraControl(iStart, iEnd) - (iStart + iEnd) * 0.5);
  float t = position.y + 0.5;
  vec3 p = memoraBezier(iStart, control, iEnd, t);
  vec3 tangent = memoraTangent(iStart, control, iEnd, t);
  vec3 d = length(tangent) > 1e-5 ? normalize(tangent) : vec3(0.0, 1.0, 0.0);
  vec3 n = cross(iEnd - iStart, control - iStart);
  n = length(n) > 1e-5 ? normalize(n) : (abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
  vec3 a = normalize(cross(d, n));
  vec3 b = cross(d, a);
  float depth = max(1.0, -(modelViewMatrix * vec4(p, 1.0)).z);
  float minR = 0.5 * uMinPixels * depth * uPixelScale;
  float r = max(iRadius, minR);
  vColor = vec4(iColor.rgb, iColor.a * clamp(iRadius / max(minR, 1e-4), 0.45, 1.0));
  vAlong = t * iLength;
  vDash = iDash;
  vDepth = depth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + (a * position.x + b * position.z) * r, 1.0);
}`;

/** Exported so the tests can assert the GLSL constants match the TypeScript ones. */
export const FLEX_SHADERS = { HIERARCHY_EDGE_VERTEX, CURVED_LINK_VERTEX, FLEX_GLSL };
