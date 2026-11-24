import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { apiPost, loginAsAdmin, sessionCsrf } from './helpers';

test('records 500-entry PDF generation time', async ({ page }, testInfo) => {
  test.skip(process.env.PERF !== '1', 'Performance checks run only with PERF=1');
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Performance checks run on desktop Chromium');
  test.setTimeout(600_000);

  await loginAsAdmin(page);
  const csrf = await sessionCsrf(page);

  for (let index = 1; index <= 500; index += 1) {
    await apiPost(page, csrf, '/events', {
      occurredAt: { precision: 'date_only', captureDate: '2026-11-01', zone: 'UTC' },
      duration: { status: 'estimated', seconds: 60 + (index % 120) },
      affectedAreas: { status: 'reported', areas: ['arms'] },
      triggers: { status: 'reported', tags: [{ id: 'trigger-stress', label: 'Stress' }] },
      aura: { status: 'none_reported' },
      rescue: { status: 'not_used' },
      eventLabel: `Perf event ${String(index).padStart(3, '0')}`,
    });
  }

  await page.goto('/reports');
  await page.getByRole('button', { name: 'Generate preview' }).click();
  await expect(page.getByText('500 logged events')).toBeVisible();

  const start = Date.now();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).first().click();
  const download = await downloadPromise;
  const elapsed = Date.now() - start;

  const downloadPath = await download.path();
  const buffer = fs.readFileSync(downloadPath as string);
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const parsed = await pdfParse(buffer);

  console.log(
    `[perf] 500-entry PDF: ${elapsed} ms, ${parsed.numpages} pages, ${Math.round(buffer.byteLength / 1024)} KiB`,
  );
  await testInfo.attach('500-entry-pdf-timing', {
    body: JSON.stringify({ elapsedMs: elapsed, pages: parsed.numpages, bytes: buffer.byteLength }),
    contentType: 'application/json',
  });
  expect(elapsed).toBeLessThan(30_000);
  expect(parsed.numpages).toBeGreaterThan(1);
});
