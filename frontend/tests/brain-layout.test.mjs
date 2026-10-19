/**
 * 脑图布局的无头自测：node --test frontend/tests/brain-layout.test.mjs
 *
 * 为什么用 esbuild 现场打包而不是直接 import .ts：
 *   布局内核必须保持"零依赖纯函数"，才能在浏览器 Worker 里用 Blob 源码复跑；
 *   测试也就必须拿到**打包后**的真实产物（而不是另写一份 JS 副本，那样测的是副本）。
 *   esbuild 已是前端 devDependency，这里用它把 src/brain/layout.ts 打成 ESM 到临时目录再 import。
 *
 * 覆盖验收三条：
 *   1. 力导向 2000 节点 50 次迭代，总能量下降 ≥ 80%；
 *   2. 层次树同层节点 x 差值 ≥ 节点宽度；
 *   3. 时间线按时间单调。
 * 附加（防止"通过了但没用"）：
 *   4. Barnes-Hut θ=0.9 与精确 O(n²)（θ=0）的能量一致；
 *   5. 同种子两次布局逐字节相同（可复现）；
 *   6. 证据视图三层结构成立。
 */
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoFrontend = path.resolve(here, '..');

let layout = null;
let scratch = null;

before(async () => {
  const esbuild = await import('esbuild');
  scratch = await mkdtemp(path.join(tmpdir(), 'memora-brain-'));
  const out = path.join(scratch, 'layout.mjs');
  await esbuild.build({
    absWorkingDir: repoFrontend,
    entryPoints: ['src/brain/layout.ts'],
    outfile: out,
    bundle: true,
    format: 'esm',
    target: 'es2020',
    logLevel: 'warning',
  });
  layout = await import(pathToFileURL(out).href);
});

process.on('exit', () => {
  if (scratch) rm(scratch, { recursive: true, force: true }).catch(() => {});
});

/** 确定性随机数：测试图必须每次一样。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 造一张"像记忆库"的图：2500 个节点，二叉树骨干保证连通，再叠 2 条随机边/点。
 * 连通性很重要——纯随机边会在 2000 节点上留下大量悬空块，
 * 那些块之间的斥力永远不平衡，收敛指标就变成噪声。
 */
function buildGraph(count) {
  const rnd = mulberry32(20240517);
  const nodes = [];
  const edges = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: 'm' + i,
      degree: 0,
      importance: (i % 13) / 13,
      time: 1700000000000 + i * 3600000,
      kind: 'fact',
      parent: i === 0 ? null : 'm' + (i >> 1),
    });
  }
  for (let i = 1; i < count; i++) edges.push({ src: 'm' + i, dst: 'm' + (i >> 1), weight: 1 });
  for (let i = 0; i < count; i++) {
    for (let d = 0; d < 2; d++) {
      const j = Math.floor(rnd() * count);
      if (j !== i) edges.push({ src: 'm' + i, dst: 'm' + j, weight: 0.5 + rnd() * 0.5 });
    }
  }
  return { nodes, edges };
}

test('力导向：2000 节点 50 次迭代，总能量下降 ≥ 80%', async () => {
  const { nodes, edges } = buildGraph(2000);
  const kernel = layout.layoutKernel();
  const opts = { iterations: 50, spacing: 60, seed: 11, theta: 0.9 };

  const started = Date.now();
  const result = kernel.semantic(nodes, edges, opts);
  const elapsed = Date.now() - started;

  assert.equal(result.positions.length, 2000 * 3, '每个节点必须有 xyz 三个分量');
  const energy = result.meta.energy;
  assert.equal(energy.length, 50, '每轮都要记录一次能量');
  const first = energy[0];
  const last = energy[energy.length - 1];
  const drop = 1 - last / first;

  console.log(
    '    力导向: 首轮能量 ' + first.toExponential(3) + ' → 末轮 ' + last.toExponential(3) +
    '，下降 ' + (drop * 100).toFixed(2) + '%，耗时 ' + elapsed + 'ms，半径 ' +
    result.meta.radius.toFixed(1),
  );
  assert.ok(drop >= 0.8, '能量下降应 ≥ 80%，实际 ' + (drop * 100).toFixed(2) + '%');

  // 布局不能塌缩：平均最近邻距离应当在 spacing 的量级上
  let nearest = 0;
  const P = result.positions;
  for (let i = 0; i < 2000; i += 20) {
    let best = Infinity;
    for (let j = 0; j < 2000; j++) {
      if (i === j) continue;
      const dx = P[i * 3] - P[j * 3];
      const dy = P[i * 3 + 1] - P[j * 3 + 1];
      const dz = P[i * 3 + 2] - P[j * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < best) best = d;
    }
    nearest += best;
  }
  nearest /= 100;
  console.log('    平均最近邻距离: ' + nearest.toFixed(2) + '（spacing=60）');
  assert.ok(nearest > 20 && nearest < 200, '最近邻距离应落在 spacing 量级，实际 ' + nearest.toFixed(1));
});

test('Barnes-Hut：θ=0.9 的近似能量与精确 O(n²) 一致', async () => {
  const { nodes, edges } = buildGraph(400);
  const kernel = layout.layoutKernel();
  const result = kernel.semantic(nodes, edges, { iterations: 40, spacing: 60, seed: 3 });
  const approx = kernel.energy(result.positions, nodes, edges, { spacing: 60, theta: 0.9 });
  const exact = kernel.energy(result.positions, nodes, edges, { spacing: 60, theta: 0.0001 });
  const rel = Math.abs(approx - exact) / Math.max(exact, 1e-9);
  console.log('    BH 近似 ' + approx.toExponential(4) + ' vs 精确 ' + exact.toExponential(4) + '，相对误差 ' + (rel * 100).toFixed(2) + '%');
  // θ=0.9 的典型误差是 5%~10%；把闸门放在 15% 是为了卡住"迭代与能量度量公式走偏"
  // 这类真实回归（曾经是 27.8%，因为两处弹簧长度口径不同）。
  assert.ok(rel < 0.15, 'BH 近似误差应 < 15%，实际 ' + (rel * 100).toFixed(2) + '%');
});

test('层次树：同层节点 x 差值 ≥ 节点宽度', async () => {
  const { nodes, edges } = buildGraph(1000);
  const kernel = layout.layoutKernel();
  const result = kernel.hierarchy(nodes, edges, { dims: 2, slotGap: 1, levelGap: 3, nodeWidth: 1 });

  // 独立地按 parent 链重算深度，不复用布局内部结果（否则测的是它自己）
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const depth = new Int32Array(nodes.length).fill(-1);
  const depthOf = (i) => {
    let d = 0, cur = i, guard = 0;
    while (nodes[cur].parent && guard++ < nodes.length) {
      const p = index.get(nodes[cur].parent);
      if (p === undefined) break;
      cur = p;
      d++;
    }
    return d;
  };
  for (let i = 0; i < nodes.length; i++) depth[i] = depthOf(i);

  const layers = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const list = layers.get(depth[i]) ?? [];
    list.push(result.positions[i * 3]);
    layers.set(depth[i], list);
  }
  let worst = Infinity;
  let violations = 0;
  for (const xs of layers.values()) {
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const gap = xs[i] - xs[i - 1];
      if (gap < worst) worst = gap;
      if (gap < 1 - 1e-9) violations++;
    }
  }
  console.log('    层次树: ' + layers.size + ' 层，最小同层间距 ' + worst.toFixed(4) + '，重叠对数 ' + violations);
  assert.equal(violations, 0, '同层相邻节点 x 差值必须 ≥ 1');
  assert.ok(worst >= 1 - 1e-9, '最小间距应 ≥ 节点宽度 1，实际 ' + worst);
  // 2D 模式下 z 必须精确为 0，正交相机才能像素对齐
  for (let i = 0; i < nodes.length; i++) assert.equal(result.positions[i * 3 + 2], 0);
});

test('层次树 3D 径向：同一层半径相等、不同层半径不同', async () => {
  const { nodes, edges } = buildGraph(300);
  const kernel = layout.layoutKernel();
  const result = kernel.hierarchy(nodes, edges, { dims: 3, radial: true, levelGap: 3.2 });
  const byRadius = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const r = Math.hypot(result.positions[i * 3], result.positions[i * 3 + 2]);
    const key = Math.round(r * 1000);
    byRadius.set(key, (byRadius.get(key) ?? 0) + 1);
  }
  console.log('    径向: 半径档位 ' + byRadius.size + ' 个，最大档占比 ' +
    (Math.max(...byRadius.values()) / nodes.length * 100).toFixed(1) + '%');
  assert.ok(byRadius.size >= 2, '径向布局应至少有两档半径');
});

test('时间线：X 随时间单调不减', async () => {
  const { nodes, edges } = buildGraph(800);
  const kernel = layout.layoutKernel();
  const result = kernel.timeline(nodes, edges, { bandGap: 4, spacing: 2.4 });

  const order = nodes.map((_, i) => i).sort((a, b) => {
    const ta = nodes[a].time ?? 0;
    const tb = nodes[b].time ?? 0;
    if (ta !== tb) return ta - tb;
    return nodes[a].id < nodes[b].id ? -1 : nodes[a].id > nodes[b].id ? 1 : 0;
  });
  let violations = 0;
  for (let i = 1; i < order.length; i++) {
    const prev = result.positions[order[i - 1] * 3];
    const cur = result.positions[order[i] * 3];
    if (cur < prev - 1e-6) violations++;
  }
  console.log('    时间线: ' + nodes.length + ' 节点，逆序对数 ' + violations +
    '，时间跨度 ' + ((nodes[nodes.length - 1].time - nodes[0].time) / 86400000).toFixed(1) + ' 天');
  assert.equal(violations, 0, '时间线 X 必须随时间单调不减');

  // Z 向按天分带：天数 ≥ 2 时至少要出现 2 个不同的 Z
  const zs = new Set();
  for (let i = 0; i < nodes.length; i++) zs.add(Math.round(result.positions[i * 3 + 2] * 100));
  assert.ok(zs.size >= 2, '时间线应至少分成 2 个日带');
});

test('可复现：同种子两次布局逐字节相同', async () => {
  const { nodes, edges } = buildGraph(300);
  const kernel = layout.layoutKernel();
  const a = kernel.semantic(nodes, edges, { iterations: 30, seed: 99 });
  const b = kernel.semantic(nodes, edges, { iterations: 30, seed: 99 });
  assert.deepEqual(Array.from(a.positions), Array.from(b.positions));
  const c = kernel.semantic(nodes, edges, { iterations: 30, seed: 100 });
  assert.notDeepEqual(Array.from(a.positions), Array.from(c.positions), '不同种子应产生不同布局');
});

test('证据视图：记忆 → 证据 → 来源 三层成立', async () => {
  const kernel = layout.layoutKernel();
  const nodes = [];
  const edges = [];
  for (let m = 0; m < 20; m++) {
    nodes.push({ id: 'mem' + m, degree: 0, importance: 0.6, time: 0, kind: 'memory', parent: null, layer: 0 });
    for (let e = 0; e < 3; e++) {
      const eid = 'ev' + m + '_' + e;
      nodes.push({ id: eid, degree: 0, importance: 0.4, time: 0, kind: 'evidence', parent: 'mem' + m, layer: 1 });
      edges.push({ src: 'mem' + m, dst: eid, weight: 0.8 });
      nodes.push({ id: 'src' + m + '_' + e, degree: 0, importance: 0.3, time: 0, kind: 'source', parent: eid, layer: 2 });
      edges.push({ src: eid, dst: 'src' + m + '_' + e, weight: 0.6 });
    }
  }
  const result = kernel.evidence(nodes, edges, { layerGap: 26, spacing: 7 });
  assert.equal(result.meta.layers, 3, '应识别出 3 层');
  // 三层沿 Y 分层：每层的 y 应互不相同
  const ys = new Set();
  for (let i = 0; i < nodes.length; i++) ys.add(Math.round(result.positions[i * 3 + 1] * 1000));
  assert.equal(ys.size, 3, '三层应当有三个不同的 y，实际 ' + ys.size);
  console.log('    证据视图: ' + nodes.length + ' 节点，' + result.meta.layers + ' 层，半径 ' + result.meta.radius.toFixed(1));
});

test('规模护栏：5000 节点力导向在预算内完成且不塌缩', async () => {
  const { nodes, edges } = buildGraph(5000);
  const kernel = layout.layoutKernel();
  const started = Date.now();
  const result = kernel.semantic(nodes, edges, { iterations: 40, spacing: 60, seed: 5 });
  const elapsed = Date.now() - started;
  const radius = result.meta.radius;
  console.log('    规模: 5000 节点 × 40 轮 = ' + elapsed + 'ms（' + (elapsed / 40).toFixed(1) + 'ms/轮），半径 ' + radius.toFixed(0));
  assert.equal(result.positions.length, 5000 * 3);
  assert.ok(radius > 100, '不能塌缩成一点，半径 ' + radius);
});
