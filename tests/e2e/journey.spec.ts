import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  createMemberViaUi,
  expectSomeVisibleText,
  login,
  loginAsAdmin,
  logout,
  ORIGIN,
  uniqueMember,
} from './helpers';

test('member journey: provision, change password, log event, analytics, PDF, isolation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const origins = new Set<string>();
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // ignore non-URL requests such as blob: downloads
    }
  });

  const memberUsername = uniqueMember('e2e-member');
  const memberPassword = 'member-e2e-password-123';

  await loginAsAdmin(page);
  const tempPassword = await createMemberViaUi(page, memberUsername, 'Synthetic Member');
  await logout(page);

  await login(page, memberUsername, tempPassword);
  await expect(page).toHaveURL(/\/change-password/);
  await expect(
    page.getByRole('heading', { name: 'Set your permanent password' }),
  ).toBeVisible();
  await page.getByLabel('Current password', { exact: true }).fill(tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(memberPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(memberPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(/\/journal/);

  await page.locator('a[href="/events/new"]').first().click();
  await expect(page).toHaveURL(/\/events\/new/);
  await page.getByText('Arms', { exact: true }).click({ force: true });
  await page.getByText('Speech', { exact: true }).click({ force: true });
  await expect(page.getByRole('checkbox', { name: 'Arms' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Speech' })).toBeChecked();
  await page.getByLabel('Duration accuracy').selectOption('estimated');
  await page.getByLabel('Minutes').fill('1');
  await page.getByLabel('Seconds').fill('25');
  await page.getByRole('button', { name: 'Stress', exact: true }).click();
  await page.getByRole('radio', { name: 'Used', exact: true }).check();
  await expect(page.getByText('Used; details not recorded is a valid answer.')).toBeVisible();
  await page.getByRole('button', { name: '+ Add administration' }).click();
  await page.getByLabel('Name as reported').fill('As reported');
  await page.getByRole('button', { name: /More details/ }).click();
  await page.getByLabel('Event label (optional)').fill('E2E synthetic event');
  await page.getByLabel('Notes (optional)').fill('Synthetic note only');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/journal/);

  await expectSomeVisibleText(page, 'Arms, Speech');
  await expectSomeVisibleText(page, 'E2E synthetic event');
  await expectSomeVisibleText(page, '1m 25s (estimated)');

  await page.reload();
  await expectSomeVisibleText(page, 'E2E synthetic event');

  await page
    .locator('a[href^="/events/"]:not([href="/events/new"]):not([href$="/edit"])')
    .evaluateAll((links) => {
      const visible = links.find((link) => link.getClientRects().length > 0);
      if (!visible) throw new Error('No visible event link');
      (visible as HTMLElement).click();
    });
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Arms, Speech').first()).toBeVisible();
  await expect(page.getByText('As reported').first()).toBeVisible();
  await expect(page.getByText('Synthetic note only').first()).toBeVisible();

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByLabel('Event label (optional)').fill('E2E updated label');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
  await expect(page.getByText('E2E updated label').first()).toBeVisible();

  await page.goto('/analytics');
  await expect(page.getByRole('heading', { name: /Logged events by/ })).toBeVisible();
  await expect(page.getByText('Days with entries').first()).toBeVisible();
  await page.getByText('View data table').click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Tag breakdown (descriptive)' }),
  ).toBeVisible();
  await expect(page.getByText('Stress', { exact: true })).toBeVisible();

  await page.goto('/reports');
  await page.getByRole('button', { name: 'Generate preview' }).click();
  await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();
  await expect(page.getByText('Notes: not included')).toBeVisible();
  await expect(page.getByText('Name: not included')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^seizure-diary_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const buffer = fs.readFileSync(downloadPath as string);
  expect(buffer.byteLength).toBeGreaterThan(1000);
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const parsed = await pdfParse(buffer);
  expect(parsed.numpages).toBeGreaterThanOrEqual(1);
  expect(parsed.text).toContain('Affected areas');
  expect(parsed.text).toContain('Arms, Speech');
  expect(parsed.text).toContain('E2E updated label');
  expect(parsed.text).toContain('Rescue medication');
  expect(parsed.text).not.toContain('Synthetic note only');
  expect(parsed.text).not.toContain('Synthetic Member');
  expect(parsed.text).toContain('Patient-entered diary');

  await logout(page);
  await loginAsAdmin(page);
  await page.goto('/journal');
  await expect(page.getByText('No logged events yet')).toBeVisible();
  await expect(page.getByText('E2E updated label')).toHaveCount(0);

  const external = [...origins].filter((origin) => origin !== ORIGIN);
  expect(external).toEqual([]);
});
