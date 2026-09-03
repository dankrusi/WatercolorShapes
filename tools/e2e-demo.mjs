/**
 * End-to-end check of the demo's workspace flows, in a real browser.
 *
 * These are the parts that cannot be tested any other way: browser storage
 * surviving a reload, a download landing on disk, and that same file coming
 * back in through the import control. Everything below is a behaviour a user
 * would notice breaking, and none of it is visible to a unit test.
 *
 *   node tools/e2e-demo.mjs [url]
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const url = process.argv[2] ?? 'http://localhost:5182/';
const downloadDir = mkdtempSync(join(tmpdir(), 'wc-e2e-'));

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    process.stdout.write('.');
  } else {
    failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
    process.stdout.write('x');
  }
}

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome or Edge binary found');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
const rendered = () =>
  page.waitForFunction(
    () => {
      const b = document.querySelectorAll('.stage-foot b');
      return b.length > 0 && b[0].textContent !== '-';
    },
    { timeout: 60000 },
  );

const tabTitles = () =>
  page.$$eval('.tabs .tab .tab-label', (els) => els.map((e) => e.textContent.trim()));
const activeTitle = () =>
  page.$eval('.tab.active .tab-label', (e) => e.textContent.trim()).catch(() => null);
const clickButton = (label) =>
  page.evaluate((text) => {
    const b = [...document.querySelectorAll('button')].find(
      (n) => n.textContent.trim() === text,
    );
    if (!b) throw new Error(`no button "${text}"`);
    b.click();
  }, label);

try {
  // Start from a clean slate so a previous run cannot mask a regression.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await rendered();

  check('starts with exactly one workspace', (await tabTitles()).length === 1, JSON.stringify(await tabTitles()));

  // Whatever the defaults happen to be, the first workspace must still be
  // showing them after the third one is edited. Captured rather than
  // hard-coded, so retuning a default cannot break this test.
  const baseline = {
    flavor: await page.$eval('.flavors button[aria-pressed=true]', (e) => e.textContent.trim()),
    seed: await page.$eval('input[type=number]', (e) => e.value),
  };

  // --- adding -------------------------------------------------------------
  await page.click('.tab-add');
  await settle();
  await page.click('.tab-add');
  await settle();
  const titles = await tabTitles();
  check('the add button creates workspaces', titles.length === 3, JSON.stringify(titles));
  check('the newest workspace is active', (await activeTitle()) === titles[2], await activeTitle());

  // --- per-workspace settings --------------------------------------------
  await clickButton('Granulate');
  await settle(1600);
  await page.evaluate(() => {
    const seed = document.querySelector('input[type=number]');
    seed.value = '4242';
    seed.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(1600);

  // Rename it by double-clicking the tab, as a user would.
  await page.evaluate(() => {
    document.querySelector('.tab.active .tab-label').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    );
  });
  await settle(200);
  await page.type('.tab-rename', 'Charcoal study');
  await page.keyboard.press('Enter');
  await settle(400);
  check('a tab can be renamed in place', (await activeTitle()) === 'Charcoal study', await activeTitle());

  // The first workspace must be untouched by all of that.
  await page.evaluate(() => document.querySelectorAll('.tabs .tab .tab-label')[0].click());
  await settle(1600);
  const firstFlavor = await page.$eval('.flavors button[aria-pressed=true]', (e) => e.textContent.trim());
  const firstSeed = await page.$eval('input[type=number]', (e) => e.value);
  check(
    'settings do not leak between workspaces',
    firstFlavor === baseline.flavor && firstSeed === baseline.seed,
    `${firstFlavor} / ${firstSeed}, expected ${baseline.flavor} / ${baseline.seed}`,
  );

  // --- persistence --------------------------------------------------------
  await page.evaluate(() => document.querySelectorAll('.tabs .tab .tab-label')[2].click());
  await settle(1600);
  await page.reload({ waitUntil: 'networkidle0' });
  await rendered();
  const afterReload = await tabTitles();
  check('workspaces survive a reload', afterReload.length === 3, JSON.stringify(afterReload));
  check('the active workspace survives a reload', (await activeTitle()) === 'Charcoal study', await activeTitle());
  const reloadedFlavor = await page.$eval('.flavors button[aria-pressed=true]', (e) => e.textContent.trim());
  const reloadedSeed = await page.$eval('input[type=number]', (e) => e.value);
  check('its settings survive a reload', reloadedFlavor === 'Granulate' && reloadedSeed === '4242', `${reloadedFlavor} / ${reloadedSeed}`);

  const storedSvg = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('watercolor-shapes/workspaces/v1'));
    return raw.workspaces.every((w) => typeof w.svg === 'string' && w.svg.includes('<svg'));
  });
  check('the SVG is stored with the workspace', storedSvg);

  // --- export -------------------------------------------------------------
  await clickButton('Export');
  await settle(1500);
  const files = readdirSync(downloadDir).filter((f) => f.endsWith('.json'));
  check('exporting writes a JSON file', files.length === 1, JSON.stringify(readdirSync(downloadDir)));

  let exportPath = null;
  if (files.length === 1) {
    exportPath = join(downloadDir, files[0]);
    const payload = JSON.parse(readFileSync(exportPath, 'utf8'));
    check('the export names its format', payload.format === 'watercolor-shapes-workspace', payload.format);
    check('the export carries the SVG', typeof payload.workspace.svg === 'string' && payload.workspace.svg.includes('<svg'));
    check('the export carries the title', payload.workspace.title === 'Charcoal study', payload.workspace.title);
    check('the export carries the flavor and seed', payload.workspace.flavor === 'granulate' && payload.workspace.seed === 4242, `${payload.workspace.flavor} / ${payload.workspace.seed}`);
    check('the export carries every parameter', Object.keys(payload.workspace.params).length >= 30, String(Object.keys(payload.workspace.params).length));
    check('the export carries the output settings', typeof payload.workspace.output.bakePaper === 'boolean');
  }

  // --- import -------------------------------------------------------------
  if (exportPath) {
    const input = await page.$('input[type=file][accept*="json"]');
    await input.uploadFile(exportPath);
    await settle(2500);
    const imported = await tabTitles();
    check('importing adds a workspace', imported.length === 4, JSON.stringify(imported));
    check('the imported workspace becomes active', (await activeTitle()) === 'Charcoal study', await activeTitle());
    const importedFlavor = await page.$eval('.flavors button[aria-pressed=true]', (e) => e.textContent.trim());
    check('the imported workspace keeps its flavor', importedFlavor === 'Granulate', importedFlavor);
  }

  // --- closing ------------------------------------------------------------
  await page.evaluate(() => document.querySelector('.tab.active .tab-close').click());
  await settle(1800);
  check('closing removes a workspace', (await tabTitles()).length === 3, JSON.stringify(await tabTitles()));

  // --- cut-out export -----------------------------------------------------
  await clickButton('Cut-out preview');
  await settle(2000);
  const cutout = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let clear = 0;
    let opaque = 0;
    let partial = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) clear++;
      else if (d[i] > 250) opaque++;
      else partial++;
    }
    return { clear, opaque, partial, total: d.length / 4 };
  });
  check('a baked cut-out is clear outside the shape', cutout.clear > cutout.total * 0.1, JSON.stringify(cutout));
  check('a baked cut-out is opaque inside the shape', cutout.opaque > cutout.total * 0.2, JSON.stringify(cutout));
  check(
    'a baked cut-out feathers only at the edge',
    cutout.partial < cutout.total * 0.05,
    JSON.stringify(cutout),
  );

  await clickButton('Bake paper');
  await settle(2000);
  const unbaked = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let partial = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] <= 250) partial++;
    return partial / (d.length / 4);
  });
  check('unbaked, the pigment carries its own transparency', unbaked > 0.15, String(unbaked));

  // --- animation ----------------------------------------------------------
  await clickButton('Bake paper');
  await clickButton('Cut-out preview');
  await settle(1500);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Animate')).click();
  });
  await settle(9000);
  const fpsText = await page.evaluate(
    () => document.querySelectorAll('.stage-foot b')[2].textContent,
  );
  const fps = Number(fpsText);
  check('animation holds its frame rate', fps >= 7 && fps <= 9.5, `measured ${fpsText}`);

  check('no page errors', pageErrors.length === 0, pageErrors.join('\n    '));
} finally {
  await browser.close();
  rmSync(downloadDir, { recursive: true, force: true });
}

process.stdout.write('\n');
if (failures.length) {
  console.error(`\n${failures.length} failed:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
}
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
