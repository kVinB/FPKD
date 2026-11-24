import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsAdmin } from './helpers';

async function seriousViolations(page: import('@playwright/test').Page) {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.waitForTimeout(100);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
}

test('no critical or serious automated accessibility violations on core screens', async ({
  page,
}) => {
  await page.goto('/login');
  let violations = await seriousViolations(page);
  expect(
    violations,
    violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);

  await loginAsAdmin(page);
  await page.goto('/journal');
  violations = await seriousViolations(page);
  expect(
    violations,
    violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);

  await page.locator('a[href="/events/new"]').first().click();
  await expect(page).toHaveURL(/\/events\/new/);
  violations = await seriousViolations(page);
  expect(
    violations,
    violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n'),
  ).toEqual([]);

  for (const path of ['/analytics', '/reports', '/settings', '/admin/accounts']) {
    await page.goto(path);
    violations = await seriousViolations(page);
    expect(
      violations,
      `${path}\n${violations.map((violation) => `${violation.id}: ${violation.help}`).join('\n')}`,
    ).toEqual([]);
  }
});
