import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  apiPost,
  createMemberViaUi,
  login,
  loginAsAdmin,
  logout,
  sessionCsrf,
  uniqueMember,
} from './helpers';

test('multipage PDF keeps selectable text, continuation labels and page numbers', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Multipage PDF runs on desktop Chromium');
  test.setTimeout(240_000);

  const memberUsername = uniqueMember('e2e-pdf');
  const memberPassword = 'member-pdf-password-123';

  await loginAsAdmin(page);
  const tempPassword = await createMemberViaUi(page, memberUsername, 'PDF Member');
  await logout(page);

  await login(page, memberUsername, tempPassword);
  await page.getByLabel('Current password', { exact: true }).fill(tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(memberPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(memberPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(/\/journal/);

  const csrf = await sessionCsrf(page);
  const longNote =
    'Synthetic long note for pagination testing. This sentence is repeated to exercise wrapping, continuation labels and page numbering without using any real health data. ';
  for (let index = 1; index <= 40; index += 1) {
    const label = `Bulk event ${String(index).padStart(2, '0')}`;
    await apiPost(page, csrf, '/events', {
      occurredAt: { precision: 'date_only', captureDate: '2026-11-01', zone: 'UTC' },
      duration: { status: 'estimated', seconds: 60 + index },
      affectedAreas:
        index % 2 === 0
          ? { status: 'reported', areas: ['arms', 'legs'] }
          : { status: 'reported', areas: ['speech'] },
      triggers: { status: 'reported', tags: [{ id: 'trigger-stress', label: 'Stress' }] },
      aura: { status: 'none_reported' },
      rescue: { status: 'not_used' },
      eventLabel: label,
      notes: `${longNote}${longNote}`,
    });
  }

  await page.goto('/reports');
  await page.getByRole('checkbox', { name: /Include notes/ }).check();
  await page.getByRole('button', { name: 'Generate preview' }).click();
  await expect(page.getByText('Notes: included')).toBeVisible();
  await expect(page.getByText('40 logged events')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).first().click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const buffer = fs.readFileSync(downloadPath as string);
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const parsed = await pdfParse(buffer);

  expect(parsed.numpages).toBeGreaterThan(1);
  expect(parsed.text).toContain('Seizure Diary (continued)');
  expect(parsed.text).toMatch(/Page 2 of \d+/);
  expect(parsed.text).toContain('Bulk event 01');
  expect(parsed.text).toContain('Bulk event 40');
  expect(parsed.text).not.toContain('Bulk event 41');
  expect(parsed.text).toContain('Synthetic long note for pagination testing');
  const occurrences = (parsed.text.match(/Bulk event 01/g) ?? []).length;
  expect(occurrences).toBe(1);

  if (process.env.PDF_RENDER === '1') {
    const prefix = testInfo.outputPath('page');
    const render = spawnSync('pdftoppm', ['-png', '-r', '100', downloadPath as string, prefix], {
      encoding: 'utf8',
    });
    expect(render.error, 'pdftoppm (poppler-utils) is required when PDF_RENDER=1').toBeUndefined();
    expect(render.status, render.stderr).toBe(0);
    const dir = path.dirname(prefix);
    const base = path.basename(prefix);
    const pages = fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(`${base}-`) && file.endsWith('.png'))
      .sort();
    expect(pages).toHaveLength(parsed.numpages);
    for (const file of pages) {
      const full = path.join(dir, file);
      const size = fs.statSync(full).size;
      expect(size, `${file} should not be a blank page`).toBeGreaterThan(5000);
      await testInfo.attach(file, { path: full, contentType: 'image/png' });
    }
  }
});
