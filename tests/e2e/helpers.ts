import { expect, type Page } from '@playwright/test';

export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password-123' };
export const ORIGIN = 'http://127.0.0.1:3100';

export function uniqueMember(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function loginAsAdmin(page: Page): Promise<void> {
  await login(page, ADMIN.username, ADMIN.password);
  await expect(page).toHaveURL(/\/journal/);
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login/);
}

export async function createMemberViaUi(
  page: Page,
  username: string,
  displayLabel: string,
): Promise<string> {
  await page.goto('/admin/accounts');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Display label (optional)', { exact: true }).fill(displayLabel);
  await page.getByRole('button', { name: 'Create member' }).click();
  const dialog = page.getByRole('dialog', { name: /Temporary credentials/ });
  await expect(dialog).toBeVisible();
  const tempPassword = await dialog.getByLabel('Temporary password').inputValue();
  expect(tempPassword.length).toBeGreaterThanOrEqual(15);
  await dialog.getByRole('button', { name: 'Done' }).click();
  return tempPassword;
}

export async function sessionCsrf(page: Page): Promise<string> {
  const response = await page.request.get('/api/v1/auth/session');
  const data = (await response.json()) as { csrfToken: string };
  return data.csrfToken;
}

export async function apiPost<T>(
  page: Page,
  csrf: string,
  url: string,
  data: unknown,
): Promise<T> {
  const response = await page.request.post(`/api/v1${url}`, {
    headers: { Origin: ORIGIN, 'X-CSRF-Token': csrf },
    data: data as object,
  });
  if (!response.ok()) {
    throw new Error(`POST ${url} failed ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export async function expectSomeVisibleText(page: Page, text: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page
          .getByText(text)
          .evaluateAll((elements) =>
            elements.filter((element) => element.getClientRects().length > 0).length,
          ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}
