/**
 * The nebula brain view ("星云关系图"), a SEPARATE brain type from 语义关系 (dictionary.ts).
 *
 * WHY IT IS SEPARATE
 * ------------------
 * The previous round replaced the 语义关系 view's layout with this nebula and the user rejected the
 * swap: they wanted the original semantic-relation brain view back, with the reference site's look
 * available as its OWN option. So dictionary.ts no longer installs this module; this entry is the
 * only thing that does, and it is reached only through the `matt` brain type.
 *
 * It is the same renderer, same projection, same focus/label/look seams as the dictionary entry --
 * the only difference is `installNebulaLayout`, which bakes section shells and cross-section Bezier
 * control points over the spring layout the host just made (see matt-layout.ts for the measured
 * reference rules). Section colour is turned ON by default here, because the shells are the whole
 * point of this view; the toolbar's 分类着色 switch still owns it after that.
 *
 * The 3D nebula has no 2D counterpart: the 2D dimension is served by the `plane` view, and the
 * workbench routes `matt` + 2D there rather than rendering an empty stage (see memory.js brain()
 * and the note it carries).
 */
import { DictionaryGraphApp } from './vendor/dictionary-graph/standalone/src/app';
import { MemorySource, fail } from './memory-source';
import { installWorkbench } from './graph-workbench';
import { installDictionaryFocus, type DictionaryHost } from './brain-focus';
import {
  installLabelDeclutter, frameDictionaryOverview, tuneDictionaryLook, type LookHost,
} from './graph-look';
import { installNebulaLayout, type NebulaHost } from './matt-layout';
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
  // Same legibility tuning the semantic view gets: the copied defaults were set for a reference
  // dictionary on a dark theme, not for a light graph of a dozen memory terms.
  const look = app as unknown as LookHost;
  tuneDictionaryLook(look);
  installLabelDeclutter((app as unknown as { stage: HTMLElement }).stage,
    () => (app as unknown as LookHost).settings.labels !== false);
  /**
   * Re-derive the reference site's baked geometry from the projection's own `## 分类标题` sections
   * and rebuild the host's scene through its public setGraph, so vendor/** stays unedited.
   * `sectionColors: true` is this view's default only; the toolbar switch takes over from there.
   */
  const nebula = installNebulaLayout(app as unknown as NebulaHost, { sectionColors: true });
  // Observation point for the acceptance run: what the bake produced, in numbers.
  (globalThis as any).memoraNebula = nebula;
  const stage = (app as unknown as { stage: HTMLElement }).stage;
  const frameOverview = (): void => {
    const rect = stage.getBoundingClientRect();
    if (rect.width < 2) return;
    tuneDictionaryLook(look);
    frameDictionaryOverview(look, { width: rect.width, height: rect.height });
  };
  window.addEventListener('resize', () => setTimeout(frameOverview, 120));
  // Automatic first frame: same policy as the dictionary view (graph-look.ts -> bestAngles ->
  // frameCluster), which for the nebula means the star cloud is searched as a whole. The nebula is
  // the largest graph this app draws, so its angle search gets its own settings (see best-view.ts
  // and the acceptance numbers in artifacts/p9-bestview-flex/report.json).
  const bestView: BestViewSeam = installBestView({
    settled: () => {
      const nodes = (app as unknown as { graph?: { nodes?: unknown[] } }).graph?.nodes;
      return !!nodes && nodes.length >= 2 && stage.getBoundingClientRect().width > 2;
    },
    apply: () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width < 2) return null;
      tuneDictionaryLook(look);
      if (!frameDictionaryOverview(look, { width: rect.width, height: rect.height })) return null;
      // The pose is read back through a cast: the copied app keeps `camera` private, and its
      // orbit camera's public azimuth/polar/distance are what the policy just chose.
      const pose = (app as unknown as { camera: { azimuth: number; polar: number; distance: number } }).camera;
      return { azimuth: pose.azimuth, polar: pose.polar, distance: pose.distance,
        source: 'focus', moved: true };
    },
  });
  (globalThis as any).memoraBestView = bestView;
  // The nebula's cross-section arcs are baked in world space; the flex layer adds the camera-facing
  // bow on top without ever writing back to `edge.control`, so the measured 0.16 ratio stays true.
  const flex: FlexSeam = installDictionaryFlex(app as unknown as Parameters<typeof installDictionaryFlex>[0]);
  (globalThis as any).memoraEdgeFlex = flex;
  installWorkbench(Object.assign(app, { bestView: () => bestView.run() }));
  /**
   * The workbench's 分类着色 button is built in graph-workbench.ts, which the hierarchy and 2D views
   * also load -- so its default belongs to them and must not change there. In this view only the
   * nebula turns section colour on, and the button has to start saying so, or its first click
   * would turn colour ON again instead of off. Writing the attribute is enough: the button's click
   * handler reads aria-pressed rather than keeping state of its own.
   *
   * The graph arrives asynchronously (the projection is fetched after start() resolves), so the
   * bake lands later than this call; the flag is re-read on the same delay the overview uses.
   */
  const syncSectionButton = (): void => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.memora-graph-controls button')]
      .find(el => el.textContent === '分类着色');
    if (button) button.setAttribute('aria-pressed', String(nebula.report !== null));
  };
  syncSectionButton();
  setTimeout(syncSectionButton, 900);
}).catch(fail);
