import { expect, test } from '@playwright/test';
import { loginAsAdmin } from './helpers';

test('320 px layout has no horizontal page scroll and keeps 44 px controls', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'small-mobile-chromium',
    'Responsive 320 px checks run in the small-mobile project',
  );

  const assertNoPageOverflow = async (label: string) => {
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
    });
    expect(overflow, `${label} should not scroll horizontally`).toBeLessThanOrEqual(1);
  };

  await page.goto('/login');
  await assertNoPageOverflow('login');

  await loginAsAdmin(page);
  await expect(page).toHaveURL(/\/journal/);
  await assertNoPageOverflow('journal');

  await page.locator('a[href="/events/new"]').first().click();
  await expect(page).toHaveURL(/\/events\/new/);
  await assertNoPageOverflow('new event');

  const shortButtons = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { label: element.textContent?.trim().slice(0, 40), height: rect.height };
      })
      .filter((entry) => entry.height > 0 && entry.height < 43.5),
  );
  expect(shortButtons, JSON.stringify(shortButtons)).toEqual([]);

  await page.goto('/reports');
  await assertNoPageOverflow('reports');

  await page.goto('/settings');
  await assertNoPageOverflow('settings');

  await page.goto('/admin/accounts');
  await assertNoPageOverflow('admin accounts');
});
