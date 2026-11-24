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

test('keeps a dirty form on connection failure and retries without duplicates', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const memberUsername = uniqueMember('e2e-offline');
  const memberPassword = 'member-offline-password-123';

  await loginAsAdmin(page);
  const tempPassword = await createMemberViaUi(page, memberUsername, 'Offline Member');
  await logout(page);

  await login(page, memberUsername, tempPassword);
  await page.getByLabel('Current password', { exact: true }).fill(tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(memberPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(memberPassword);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page).toHaveURL(/\/journal/);

  await page.locator('a[href="/events/new"]').first().click();
  await expect(page).toHaveURL(/\/events\/new/);
  await page.getByText('Arms', { exact: true }).click({ force: true });
  await page.getByText('Speech', { exact: true }).click({ force: true });
  await page.getByLabel('Duration accuracy').selectOption('estimated');
  await page.getByLabel('Minutes').fill('1');
  await page.getByLabel('Seconds').fill('5');
  await page.getByRole('button', { name: 'Stress', exact: true }).click();
  await page.getByRole('button', { name: /More details/ }).click();
  await page.getByLabel('Event label (optional)').fill('Offline draft event');
  await page.getByLabel('Notes (optional)').fill('Synthetic offline note');

  await page.route('**/api/v1/events', async (route) => {
    if (route.request().method() === 'POST') {
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText(/Not saved\. Connect to your home network or WireGuard and retry\./).first(),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/events\/new/);
  await expect(page.getByLabel('Event label (optional)')).toHaveValue('Offline draft event');
  await expect(page.getByLabel('Notes (optional)')).toHaveValue('Synthetic offline note');
  await expect(page.getByRole('checkbox', { name: 'Arms' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Speech' })).toBeChecked();

  const notSaved = await page.request.post('/api/v1/events/query', {
    headers: { Origin: ORIGIN },
    data: { page: 1 },
  });
  expect(notSaved.ok()).toBe(true);
  expect((await notSaved.json()) as { total: number }).toMatchObject({ total: 0 });

  await page.unroute('**/api/v1/events');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/journal/);
  await expect(page.getByText(/1 logged event/)).toBeVisible();
  await expectSomeVisibleText(page, 'Offline draft event');

  await page.reload();
  await expect(page.getByText(/1 logged event/)).toBeVisible();
  await expectSomeVisibleText(page, 'Offline draft event');
});
