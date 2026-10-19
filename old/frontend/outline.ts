import { MindMapApp } from './vendor/original-dev/standalone/src/app';
import { MemorySource, fail } from './memory-source';
import { installWorkbench } from './graph-workbench';
import { installFlowOverlay, installOutlineFocus, type OutlineHost } from './brain-focus';
import { installBestView, type BestViewSeam } from './best-view';
import { installOutlineFlex, type FlexSeam } from './edge-flex-dom';
try { if (!localStorage.getItem('mindmap.locale')) localStorage.setItem('mindmap.locale', 'zh'); } catch {}
const app = new MindMapApp({source: new MemorySource(), bodyClass: 'is-web'});
(window as any).mindMap = app;
void app.start().then(() => {
  // Same seam as the dictionary: the copied host's own `select` is re-bound
  // with framing suppressed, and Memora decides where the camera goes.
  installOutlineFocus(app as unknown as OutlineHost);
  // Parent -> child direction, drawn by Memora over the copied renderer: the
  // host's own edge shader is too faint a pulse to read as a direction.
  const flow = installFlowOverlay(app as unknown as OutlineHost);
  (window as any).memoraFlow = flow;
  // The workbench's flow switch drives this overlay directly.
  (app as unknown as { flowOverlay?: typeof flow }).flowOverlay = flow;
  /**
   * Automatic best view.
   *
   * The copied host HAS rig.bestOrientation() and `overview()` uses it, but the first frame does
   * not: `frameWhenSettled()` calls `frameAll(true, 0)`, and `frameAll` gates the orientation pick
   * on `settings.bestViewOnFrame` -- which is true by default, so the pick SHOULD happen. What the
   * measurement shows is that it happens exactly once and only if the layout is still active when
   * frameWhenSettled fires; on a slow settle the host frames with `frameAll(true, 0)` against
   * positions that are still moving. So the seam's `apply` calls the public `overview()`, which
   * re-frames from the settled layout AND picks the orientation, after the layout has actually
   * stopped.
   *
   * `source` says 'vendor' because the angles come from rig.bestOrientation(), not from focus.ts --
   * that is the honest label, and the report distinguishes the two.
   */
  const host = app as unknown as OutlineHost;
  const bestView: BestViewSeam = installBestView({
    settled: () => {
      const renderer = (app as unknown as { rendererRef?: { rig?: { animating: boolean } } }).rendererRef;
      const engine = (app as unknown as { engine?: { active: boolean; count: number } }).engine;
      return !!engine && engine.count >= 2 && !!renderer && !renderer.rig?.animating && !engine.active;
    },
    timeoutMs: 20000,
    apply: (ms: number) => {
      const sphericalBefore = host.rendererRef.rig.toSpherical();
      (app as unknown as { overview(): void }).overview();
      const rig = host.rendererRef.rig as unknown as { orientation?: { x: number; y: number; z: number; w: number } };
      const q = rig.orientation;
      const spherical = host.rendererRef.rig.toSpherical();
      // The rig animates to its goal; report the goal, which is what the search chose.
      const moved = Math.abs(spherical.azimuth - sphericalBefore.azimuth) > 1e-4
        || Math.abs(spherical.polar - sphericalBefore.polar) > 1e-4
        || ms === 0;
      return {
        azimuth: spherical.azimuth, polar: spherical.polar, distance: spherical.radius,
        quaternion: q ? [q.x, q.y, q.z, q.w] : undefined,
        source: 'vendor', moved,
      };
    },
  });
  (globalThis as any).memoraBestView = bestView;
  /**
   * Links flex with the viewing direction.
   *
   * Both of this renderer's link layers are instanced shaders whose bend is computed in GLSL from
   * `cameraPosition`, so the deformation costs nothing on the CPU and needs no per-frame tick. The
   * arrowheads that cap note links are a separate CPU-placed cone mesh; they are left unbent (see
   * edge-flex-dom.ts) rather than detached from their curves.
   */
  const flex: FlexSeam = installOutlineFlex(app as unknown as Parameters<typeof installOutlineFlex>[0]);
  (globalThis as any).memoraEdgeFlex = flex;
  installWorkbench(Object.assign(app, { bestView: () => bestView.run() }));
}).catch(fail);
