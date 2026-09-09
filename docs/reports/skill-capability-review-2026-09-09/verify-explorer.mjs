// Verify the offline report's user-visible behavior; no model or production access.
import { createRequire } from 'node:module';
import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const operator = resolve(root, '../../../../agentic-operator');
const require = createRequire(resolve(operator, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const manifest = JSON.parse(await readFile(resolve(root, 'evaluation-manifest.json'), 'utf8'));
const failures = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', m => { if (m.type() === 'error') failures.push(m.text()); });
  page.on('request', r => { if (/^https?:/.test(r.url())) failures.push('Unexpected network request: ' + r.url()); });
  await page.goto(pathToFileURL(resolve(root, 'index.html')).href);
  assert.equal(await page.locator('#rows .skill-button').count(), 53);
  await page.locator('#risk').selectOption('high');
  assert.equal(await page.locator('#rows .skill-button').count(), manifest.summary.riskCounts.high);
  await page.locator('#shared').check();
  assert.equal(await page.locator('#rows .skill-button').count(), manifest.summary.ontoWorkRiskCounts.high);
  await page.locator('#risk').selectOption('');
  assert.equal(await page.locator('#rows .skill-button').count(), 14);
  await page.locator('#reset').click();
  await page.locator('#action').selectOption('retire-duplicate');
  assert.equal(await page.locator('#rows .skill-button').count(), 1);
  assert.match(await page.locator('#rows').innerText(), /openai\/curated\/chatgpt-apps/);
  await page.locator('#reset').click();
  await page.locator('#search').fill('no-matching-skill-981763');
  assert.equal(await page.locator('#rows .skill-button').count(), 0);
  assert.match(await page.locator('#rows').innerText(), /No skills match/);
  await page.locator('#reset').click();
  for (const skill of manifest.skills) {
    await page.getByRole('button', { name: skill.id, exact: true }).click();
    assert.equal(await page.locator('#detail-title').innerText(), skill.id);
    const body = await page.locator('#detail-body').innerText();
    assert.ok(body.includes(skill.assessment), skill.id);
    assert.ok(body.includes('GPT-6 Astra:'), skill.id);
    assert.ok(body.includes('Fable 5.1:'), skill.id);
    assert.equal(await page.locator('#detail-body .evidence').count(), skill.risks.reduce((n,r) => n+r.evidence.length,0));
    await page.locator('#close').click();
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: resolve(root, 'explorer-desktop.png') });
  await page.getByRole('button', { name: 'agentic/skill-creator', exact: true }).click();
  await page.screenshot({ path: resolve(root, 'explorer-detail.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail').isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  assert.ok(noOverflow, 'Mobile page overflows; table may scroll internally but page must fit.');
  await page.screenshot({ path: resolve(root, 'explorer-mobile.png') });
  const localLinks = await page.locator('a[href]').evaluateAll(links => links.map(a => a.getAttribute('href')).filter(h => !/^https?:/.test(h)));
  for (const href of localLinks) await access(resolve(root, href));
  assert.deepEqual(failures, []);
  const result = {
    verifiedAt: new Date().toISOString(), result: 'passed',
    htmlSha256: createHash('sha256').update(await readFile(resolve(root, 'index.html'))).digest('hex'),
    scope: 'Offline report UI only; no model behavior benchmark',
    checks: ['53 visible skills', 'risk and shared filters intersect correctly', 'recommendation filter',
      'search empty state', 'all 53 detail views and evidence counts', 'keyboard modal dismissal',
      'mobile page fits viewport', 'local artifact links resolve', 'no page or console errors', 'no network requests'],
    screenshots: ['explorer-desktop.png', 'explorer-detail.png', 'explorer-mobile.png'],
  };
  await writeFile(resolve(root, 'explorer-validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
