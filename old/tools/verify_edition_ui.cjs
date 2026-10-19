// P5 edition-banner acceptance: the words under the wordmark must come from the RUNNING backend.
//
// The point of this script is that it does not trust the implementation. It starts each edition,
// loads the page, and reads the rendered text out of the DOM exactly where a user would see it:
// the sidebar brand block in the top-left corner. A hardcoded label passes the source review and
// fails here, because the same page source is served by both editions and the script requires the
// text to CHANGE between them.
//
// It also measures the geometry: "左上角 memora 字样下方" is a requirement about position, not only
// about text, so the edition line must sit below the wordmark and inside the sidebar's left column.
//
// Run from the repository root:
//   .\desktop\node_modules\electron\dist\electron.exe tools\verify_edition_ui.cjs
//   (clear ELECTRON_RUN_AS_NODE first if this shell has it set)
//
// Writes artifacts/p5-editions/*.png and artifacts/p5-editions/report.json.
// Exit code 0 only when every assertion passes. When the rendering is not wired up yet it reports
// which text/ids are missing and exits non-zero - it never reports a missing banner as a pass.
const {app, BrowserWindow} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

const root = path.resolve(__dirname, '..');
const product = path.resolve(root, '..', 'memora-desktop-standalone');
const exe = path.join(product, 'resources', 'backend', 'memora-backend.exe');
const productSettings = path.join(product, 'data', 'memora.json');
const out = path.join(root, 'artifacts', 'p5-editions');
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const delay = ms => new Promise(r => setTimeout(r, ms));

const checks = [];
const errors = [];
const check = (name, pass, detail) => {
  checks.push({name, pass: !!pass, detail});
  if (!pass) errors.push(name);
  return !!pass;
};

// One backend process per edition. --port 0: the OS picks a free port, so this never fights a dev
// session that is already running (the author is usually looking at one while running this).
function startBackend(spec) {
  // NOTE: MEMORA_EDITION is deliberately NOT set. The whole point is that a source checkout says
  // "devel" and a frozen build says "standalone" WITHOUT being told, so setting the override here
  // would prove only that the override works. (The override exists for the release check, which
  // uses it to prove the frozen build can be labelled explicitly - see tools/verify_editions.py.)
  const env = {...process.env, PYTHONUTF8: '1'};
  delete env.MEMORA_EDITION;
  const child = spawn(spec.command, spec.args, {cwd: spec.cwd, windowsHide: true, env,
    stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(spec.edition + ' backend timeout: ' + stderr)), 90000);
    child.stdout.on('data', b => {
      text += b;
      const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve({child, base: m[0], pid: child.pid}); }
    });
    child.once('exit', code => reject(new Error(spec.edition + ' backend exited ' + code + ': ' + stderr)));
  });
}

/**
 * Read the banner the way a user sees it. Everything asserted below is visible text or geometry:
 * no variable, no module global, no "the code says so".
 */
const READ_BANNER = `(() => {
  const text = el => (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  const visible = el => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
      && box.width > 0 && box.height > 0;
  };
  const brand = document.querySelector('aside .brand');
  const wordmark = text(brand);
  // The edition block is the element directly under the wordmark in the sidebar brand area. It is
  // located by POSITION, not only by id, so a different markup still has to put it in the right
  // place; the id is reported as well so a missing implementation names what to add.
  const aside = document.querySelector('aside');
  const candidates = aside ? [...aside.querySelectorAll('*')].filter(el => /^(devel|standalone|版本未知)$/.test(text(el))) : [];
  const asideBox = aside ? aside.getBoundingClientRect() : {left: 0, width: 0};
  const wordmarkBox = brand ? brand.getBoundingClientRect() : null;
  // Glyph boxes, not the anchor's margin box: ".brand" contains the subtitle and its bottom margin,
  // so the element box ends BELOW where the words are printed. "below the memora wordmark" is a
  // statement about the visible text, so the reference is a text Range over the wordmark plus a
  // Range over the subtitle.
  const rangeBox = node => {
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    return box && box.height ? {top: Math.round(box.top), bottom: Math.round(box.bottom),
      left: Math.round(box.left), width: Math.round(box.width)} : null;
  };
  const subtitle = brand ? brand.querySelector('small') : null;
  const wordmarkText = brand ? rangeBox(brand.cloneNode(true)) : null;
  // The visible bottom of the wordmark block = the subtitle's glyphs when there is one (that is the
  // last printed line under "memora"), otherwise the wordmark's own glyphs.
  const printedBottom = (subtitle ? rangeBox(subtitle) : null) || wordmarkBox;
  const lines = candidates.map(el => {
    const box = el.getBoundingClientRect();
    const glyphs = rangeBox(el);
    return {text: text(el), id: el.id || null, className: el.className || null,
      top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width),
      glyphTop: glyphs ? glyphs.top : null,
      belowWordmark: printedBottom ? (glyphs || box).top >= printedBottom.bottom - 2 : null,
      inLeftColumn: box.left - asideBox.left < Math.max(240, asideBox.width)};
  });
  const marked = document.getElementById('edition-mark');
  const versionEl = document.getElementById('edition-version');
  return {
    title: document.title,
    wordmark,
    wordmarkVisible: visible(brand),
    wordmarkBox: wordmarkBox ? {left: Math.round(wordmarkBox.left), top: Math.round(wordmarkBox.top),
      width: Math.round(wordmarkBox.width), height: Math.round(wordmarkBox.height)} : null,
    wordmarkGlyphs: wordmarkText,
    subtitleGlyphs: subtitle ? rangeBox(subtitle) : null,
    asideBox: asideBox ? {left: Math.round(asideBox.left), width: Math.round(asideBox.width)} : null,
    edition: document.getElementById('edition') ? {
      present: true,
      visible: visible(document.getElementById('edition')),
      dataset: document.getElementById('edition').dataset.edition || null,
      title: document.getElementById('edition').title || null,
      text: text(document.getElementById('edition')),
    } : {present: false},
    editionMark: {present: !!marked, visible: visible(marked), text: text(marked)},
    editionVersion: {present: !!versionEl, visible: visible(versionEl), text: text(versionEl)},
    editionLinesUnderWordmark: lines,
    bodyText: text(document.body).slice(0, 400),
  };
})()`;

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
  return name;
}

/** Assert the banner for one edition, then leave a screenshot behind as evidence. */
async function verifyEdition(win, edition, backend, spec) {
  const base = backend.base;
  console.log(edition, 'backend', base, 'pid', backend.pid);
  // The backend's own answer is the reference the DOM is compared against; a page that prints
  // something else (including something prettier) is a failure, not a variation.
  const status = await (await fetch(base + '/api/agent/status')).json();
  console.log(edition, 'status edition=' + JSON.stringify(status.edition),
    'version=' + JSON.stringify(status.version), 'label=' + JSON.stringify(status.edition_label));

  await win.loadURL(base + '/?project=default');
  await delay(1200);
  // Wait for the banner to be painted. The page reads status asynchronously; polling for the
  // text is more honest than a fixed sleep, and it fails loudly when the text never arrives.
  let banner = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    banner = await win.webContents.executeJavaScript(READ_BANNER);
    if (banner.editionMark.text && banner.editionMark.text !== '版本读取中') break;
    await delay(250);
  }
  const prefix = edition + ': ';
  const expectedVersionText = 'v' + status.version;
  const expectedLabel = edition;  // devel | standalone, exactly as the backend reports it

  check(prefix + 'the backend reports this edition', status.edition === edition,
    {edition: status.edition, expected: edition});
  check(prefix + 'the edition banner element is in the DOM (id="edition")', banner.edition.present,
    banner.edition.present ? null : 'the sidebar has no #edition block');
  check(prefix + 'the edition word is visible on screen', banner.edition.visible,
    {edition: banner.edition});
  check(prefix + 'the edition word matches the backend (not a hardcoded label)',
    banner.editionMark.text === expectedLabel, {shown: banner.editionMark.text, backend: expectedLabel});
  check(prefix + 'the version under the wordmark is v' + status.version,
    banner.editionVersion.text === expectedVersionText,
    {shown: banner.editionVersion.text, backend: status.version});
  check(prefix + 'the banner carries the edition as data, for styling and for this check',
    banner.edition.dataset === edition, {dataset: banner.edition.dataset});
  const line = banner.editionLinesUnderWordmark.find(item => item.text === expectedLabel);
  check(prefix + 'the edition line sits BELOW the memora wordmark',
    !!line && line.belowWordmark === true, line || {lines: banner.editionLinesUnderWordmark});
  check(prefix + 'the edition line sits in the LEFT column (sidebar), not the main area',
    !!line && line.inLeftColumn === true,
    line ? {left: line.left, aside: banner.asideBox} : {lines: banner.editionLinesUnderWordmark});
  check(prefix + 'the memora wordmark is visible in the top-left brand block',
    banner.wordmarkVisible && /memora/i.test(banner.wordmark),
    {wordmark: banner.wordmark, box: banner.wordmarkBox});
  const printedBottom = banner.subtitleGlyphs || banner.wordmarkGlyphs;
  if (line && printedBottom) {
    const gap = line.glyphTop - printedBottom.bottom;
    check(prefix + 'the edition line is directly under the printed wordmark (0-120px gap)',
      gap >= -2 && gap <= 120, {gapPx: gap, editionTop: line.glyphTop, wordmarkBottom: printedBottom.bottom});
  } else {
    check(prefix + 'the edition line is directly under the printed wordmark (0-120px gap)', false,
      'no edition line found in the sidebar');
  }
  await shot(win, 'brand-' + edition + '.png');
  return {edition, status: {edition: status.edition, version: status.version, label: status.edition_label},
    base, pid: backend.pid, banner, screenshot: 'brand-' + edition + '.png',
    // An edition the backend does not report is an OLD BUILD, not a rendering bug: the page asks the
    // backend and refuses to guess, so the fix is the build, not the CSS.
    note: status.edition === edition ? null
      : 'this backend does not report edition at all, so the page honestly renders neither value; '
        + 'the frozen copy at resources/backend predates the field and must be rebuilt '
        + '(tools/build_desktop.py copies both the page assets and the backend)'};
}

async function main() {
  fs.mkdirSync(out, {recursive: true});
  app.setPath('userData', path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p5-')), 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();

  const tempData = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p5-data-'));
  const devSpec = {edition: 'devel', cwd: root, command: python,
    args: ['-m', 'memora', '--data', path.join(tempData, 'devel'), 'serve', '--port', '0']};
  const standData = path.join(tempData, 'standalone');
  fs.mkdirSync(standData, {recursive: true});
  // The packaged app's saved model settings only; never its memories, never its live data/.
  if (fs.existsSync(productSettings)) fs.copyFileSync(productSettings, path.join(standData, 'memora.json'));
  const standSpec = {edition: 'standalone', cwd: path.dirname(exe), command: exe,
    args: ['--data', standData, 'serve', '--port', '0']};

  const win = new BrowserWindow({show: false, width: 1400, height: 950, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true,
    backgroundThrottling: false,
  }});
  const pageErrors = [];
  win.webContents.on('console-message', (...args) => {
    const detail = args.find(a => a && typeof a === 'object' && a.level);
    if (detail && detail.level === 'error') pageErrors.push(detail.message);
  });

  const results = {};
  const backends = [];
  try {
    // The dev-tree backend carries the banner source because the page is served from it. The
    // standalone backend carries its own frozen copy of that page.
    const dev = await startBackend(devSpec); backends.push(dev);
    results.devel = await verifyEdition(win, 'devel', dev, devSpec);
    if (fs.existsSync(exe)) {
      const stand = await startBackend(standSpec); backends.push(stand);
      results.standalone = await verifyEdition(win, 'standalone', stand, standSpec);
    } else {
      check('standalone: the packaged backend exists', false,
        path.relative(root, exe) + ' is missing; run tools/build_desktop.py');
    }

    // The decisive assertion: the same ROUTE rendered two DIFFERENT labels. A constant in the page
    // cannot satisfy this, which is the whole reason the script reads the DOM instead of the code.
    const rendered = Object.values(results).map(r => r.banner.editionMark.text);
    check('the two editions render DIFFERENT, non-empty text from the same page route',
      rendered.length === 2 && rendered.every(Boolean) && rendered[0] !== rendered[1], rendered);
    check('no console errors while loading the page', pageErrors.length === 0, pageErrors.slice(0, 5));
  } finally {
    for (const backend of backends) { try { backend.child.kill(); } catch (error) { /* already gone */ } }
    win.destroy();
  }

  const report = {
    suite: 'P5 edition banner acceptance',
    command: '.\\desktop\\node_modules\\electron\\dist\\electron.exe tools\\verify_edition_ui.cjs'
      + '   (run from the repository root; clear ELECTRON_RUN_AS_NODE first if it is set)',
    requirement: 'the sidebar top-left shows memora, and under it the edition (devel|standalone) and v<version>',
    data_directory: tempData,
    editions: results,
    assertions: checks,
    screenshots: fs.readdirSync(out).filter(name => name.endsWith('.png')).sort(),
    page_errors: pageErrors,
    passed: errors.length === 0,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify({passed: report.passed, assertions: checks.length,
    failed: errors, screenshots: report.screenshots}, null, 2));
  if (errors.length) throw new Error('failed assertions: ' + errors.join(', '));
}

main().then(() => app.quit())
  .catch(error => { console.error(error.stack); app.exit(1); });