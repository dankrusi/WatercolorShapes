/**
 * Drive the demo in a real browser and report what it does.
 *
 * Chrome's `--screenshot` with a virtual time budget is not usable here: the
 * render runs on a worker thread doing real CPU work, and the virtual clock
 * expires long before it finishes, so the page is captured blank whether it
 * works or not. This waits on the page's own state instead, and forwards
 * console output and page errors so a failure says what failed.
 *
 *   node tools/shoot-demo.mjs <url> <outPng> [--flavor=bloom] [--animate]
 */

import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const url = process.argv[2] ?? 'http://localhost:5177/';
const out = process.argv[3] ?? 'demo.png';
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const sample = arg('sample');
const has = (n) => process.argv.includes(`--${n}`);

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) throw new Error('No Chrome or Edge binary found');

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 880, deviceScaleFactor: 1 });

const problems = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') problems.push(`console.${t}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

// Wait for the first frame: the footer only shows a size once a render lands.
await page.waitForFunction(
  () => {
    const b = document.querySelectorAll('.stage-foot b');
    return b.length > 0 && b[0].textContent !== '-';
  },
  { timeout: 60000 },
);

if (sample) {
  await page.select('.panel select', sample);
  await new Promise((r) => setTimeout(r, 2500));
}

const flavor = arg('flavor');
if (flavor) {
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll('.flavors button')].find(
      (b) => b.textContent.trim().toLowerCase() === label.toLowerCase(),
    );
    if (!btn) throw new Error(`no flavor button "${label}"`);
    btn.click();
  }, flavor);
  await new Promise((r) => setTimeout(r, 2500));
}

if (has('animate')) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.includes('Animate'),
    );
    btn.click();
  });
  // Long enough for the smoothed fps readout to settle.
  await new Promise((r) => setTimeout(r, 6000));
}

const stats = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.stage-foot b')].map((n) => n.textContent);
  const canvas = document.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  // Distinct colours in a sparse sample: a blank canvas has one or two.
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4 * 97) {
    seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  const err = document.querySelector('.err');
  return {
    size: b[0],
    render: b[1],
    fps: b[2],
    seed: b[3],
    shapes: b[4],
    canvas: `${canvas.width}x${canvas.height}`,
    distinctColours: seen.size,
    error: err && err.style.display !== 'none' ? err.textContent : null,
  };
});

await page.screenshot({ path: out });
await browser.close();

console.log(JSON.stringify(stats, null, 2));
if (problems.length) {
  console.log('--- page problems ---');
  for (const p of problems) console.log(p);
}
if (stats.error) process.exitCode = 1;
if (stats.distinctColours < 50) {
  console.log('FAIL: canvas looks blank');
  process.exitCode = 1;
}
