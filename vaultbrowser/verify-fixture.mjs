// Start the separate fixtures/vault Vite entry before running this synthetic UI check.
import assert from 'node:assert/strict';
import { chromium } from '../wikibrowser/node_modules/@playwright/test/index.mjs';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const external = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1' && url.protocol !== 'blob:') { external.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(() => {
    window.syntheticBlobEvents = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.syntheticBlobEvents.push(['create', url]); return url; };
    URL.revokeObjectURL = url => { window.syntheticBlobEvents.push(['revoke', url]); return revoke(url); };
  });
  await page.goto(process.env.VAULT_FIXTURE_URL ?? 'http://127.0.0.1:3023/?state=unlocked');
  const title = page.getByLabel('Document title');
  await title.waitFor();
  await title.fill('Synthetic edited title');
  const editor = page.locator('.cm-content[contenteditable="true"]');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n![private](https://example.invalid/private-resource)\n[private](https://example.invalid/private-link)');
  assert.match(await editor.innerText(), /private-resource/);
  await page.keyboard.press('Tab');
  assert.equal(await editor.evaluate(element => element === document.activeElement), false, 'Editor must allow Tab to leave');
  const preview = page.getByText('Private Markdown preview', { exact: true });
  await preview.focus(); await page.keyboard.press('Enter');
  assert.equal(await preview.evaluate(element => element.parentElement.open), true);
  assert.equal(await page.locator('img[src*="example.invalid"], a[href*="example.invalid"]').count(), 0);
  const revert = page.getByRole('button', { name: 'Revert', exact: true });
  await revert.focus(); await page.keyboard.press('Enter');
  assert.equal(await title.inputValue(), 'Synthetic travel checklist');
  assert.doesNotMatch(await editor.innerText(), /private-resource/);
  const history = page.getByRole('button', { name: 'Show version history' });
  await history.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Download revision 1' }).waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download document', exact: true }).click();
  assert.match((await download).suggestedFilename(), /revision-1\.bin$/);
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await page.getByLabel('Document type').selectOption('credential');
  await page.getByLabel('Username', { exact: true }).fill('synthetic account');
  await page.getByLabel('Password', { exact: true }).fill('synthetic secret password');
  const reveal = page.getByRole('button', { name: 'Show password', exact: true });
  await reveal.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Password', { exact: true }).getAttribute('type'), 'text');
  await page.getByLabel('Search this Vault locally').fill('synthetic search');
  const lock = page.getByRole('button', { name: 'Lock Vault', exact: true });
  await lock.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('Password', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Search this Vault locally').count(), 0);
  assert.equal(await page.locator('.cm-editor').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /synthetic secret password|synthetic account|synthetic search/);
  assert.equal(await page.getByLabel('Export recovery secret').count(), 1);
  const events = await page.evaluate(() => window.syntheticBlobEvents);
  assert.equal(events.filter(([type]) => type === 'create').length, 1);
  assert.equal(events.filter(([type]) => type === 'revoke').length, 1);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log('Synthetic Chromium Vault checks passed: editor input/revert, keyboard exit/disclosures/history, credential reveal, private preview, download/revoke, lock destruction, no browser persistence or external requests.');
  console.log('This fixture does not establish real canister, Internet Identity or passkey acceptance.');
} finally { await browser.close(); }
