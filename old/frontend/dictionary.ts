/**
 * The semantic-relation brain view.
 *
 * This is the view the user accepted BEFORE the matt nebula experiment, and it is deliberately
 * back to that behaviour: the copied dictionary renderer parses the Markdown projection and lays
 * the terms out with its own spring embedder; every edge keeps `control === null` and is drawn as
 * a straight line. The nebula (baked section shells + curved cross-section links, see
 * matt-layout.ts) is a SEPARATE brain type now -- `matt.ts` -- because replacing this view with it
 * was rejected: the reference site's arrangement is not what this view is for.
 *
 * The look/legibility tuning below is NOT part of the nebula experiment and stays: resting-link
 * opacity, label density, the label declutter pass and the first-frame fit were all done for
 * readability on a light 14-term graph.
 *
 * 分类着色 stays OFF by default here, as the copied host builds it (graph-workbench.ts): only the
 * nebula view needs section colour to be readable, so only that entry turns it on.
 */
import { DictionaryGraphApp } from './vendor/dictionary-graph/standalone/src/app';
import { MemorySource, fail } from './memory-source';
import { installWorkbench } from './graph-workbench';
import { installDictionaryFocus, type DictionaryHost } from './brain-focus';
import {
  installLabelDeclutter, frameDictionaryOverview, tuneDictionaryLook, type LookHost,
} from './graph-look';
import { installBestView, type BestViewSeam } from './best-view';
import { installDictionaryFlex, type FlexSeam } from './edge-flex-dom';
import { installMemoryPresentation, type MemoryPresentationHost } from './memory-presentation';
try { if (!localStorage.getItem('dictionary-graph.locale')) localStorage.setItem('dictionary-graph.locale', 'zh'); } catch {}
const app = new DictionaryGraphApp({source: new MemorySource(), bodyClass: 'is-web'});
(window as any).dictionaryGraph = app;
void app.start().then(() => {
  // Camera framing for a selected node belongs to Memora, not to the copied
  // host: the host fits a bounding sphere before its panel has opened. The
  // host's public `select` is the seam, so vendor/** stays unedited.
  installDictionaryFocus(app as unknown as DictionaryHost);
  installMemoryPresentation(app as unknown as MemoryPresentationHost);
  // Resting links and label density are tuned for a reference dictionary on a
  // dark theme; on a light 14-term memory graph they are invisible and overprinted.
  // Both are set through the host's own patch(), so the toolbar switches still own them.
  const look = app as unknown as LookHost;
  tuneDictionaryLook(look);
  // The label layer draws every name, has no collision test of its own, and its "显示标签"
  // switch does not stay off (see installLabelDeclutter). Both are fixed from outside vendor/**.
  installLabelDeclutter((app as unknown as { stage: HTMLElement }).stage,
    () => (app as unknown as LookHost).settings.labels !== false);
  // The first frame is fitted from the centre of the whole graph, which leaves the
  // demo graph small and its names crowded. Frame it with the same per-axis policy a
  // click uses, once the layout has settled. The host announces frames through
  // startLoop; a short delay is enough for the first settled positions.
  const stage = (app as unknown as { stage: HTMLElement }).stage;
  const frameOverview = (): void => {
    const rect = stage.getBoundingClientRect();
    if (rect.width < 2) return;
    tuneDictionaryLook(look);
    frameDictionaryOverview(look, { width: rect.width, height: rect.height });
  };
  window.addEventListener('resize', () => setTimeout(frameOverview, 120));
  // The first frame: rotate to the angle the graph reads best at, once the projection has arrived.
  // `frameOverview` above already does exactly that (graph-look.ts -> bestAngles -> frameCluster), so
  // the automatic path reuses it rather than searching twice; the seam only owns WHEN.
  const bestView: BestViewSeam = installBestView({
    settled: () => {
      const nodes = (app as unknown as { graph?: { nodes?: unknown[] } }).graph?.nodes;
      return !!nodes && nodes.length >= 2 && stage.getBoundingClientRect().width > 2;
    },
    apply: () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width < 2) return null;
      tuneDictionaryLook(look);
      // Reuse the same policy as the overview, then report the pose it landed on.
      if (!frameDictionaryOverview(look, { width: rect.width, height: rect.height })) return null;
      // The pose is read back through a cast: the copied app keeps `camera` private, and its
      // orbit camera's public azimuth/polar/distance are what the policy just chose.
      const pose = (app as unknown as { camera: { azimuth: number; polar: number; distance: number } }).camera;
      return { azimuth: pose.azimuth, polar: pose.polar, distance: pose.distance,
        source: 'focus', moved: true };
    },
  });
  (globalThis as any).memoraBestView = bestView;
  // Links flex with the viewing direction (edge-flex.ts). This is derived geometry only: the graph's
  // own `control` values are never written, so the layout stays exactly what the projection says.
  const flex: FlexSeam = installDictionaryFlex(app as unknown as Parameters<typeof installDictionaryFlex>[0]);
  (globalThis as any).memoraEdgeFlex = flex;
  installWorkbench(Object.assign(app, {
    bestView: () => {
      const outcome = bestView.run();
      if (!outcome) return null;
      (globalThis as any).memoraFocus = null;
      return outcome;
    },
  }));
}).catch(fail);
