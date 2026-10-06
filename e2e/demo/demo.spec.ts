import { expect, test, type FrameLocator, type Page } from '@playwright/test';

// The demo build runs the whole app in the page, with sample Kajang shops.
// Here it runs in a sandboxed iframe under a strict Content-Security-Policy,
// with no network and with alert/confirm blocked, the way it is shared.

let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  // Runs in the iframe too: report anything the browser blocked or that broke.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`Blocked by CSP: ${e.violatedDirective} ${e.blockedURI}`),
    );
    window.addEventListener('unhandledrejection', (e) => console.error(`Unhandled rejection: ${String(e.reason)}`));
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
});

test.afterEach(() => {
  expect(problems).toEqual([]);
});

async function snap(page: Page, name: string) {
  const dir = process.env.SCREENSHOTS;
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

const button = (app: FrameLocator, name: string | RegExp) =>
  app.getByRole('button', { name, exact: typeof name === 'string' });

async function open(page: Page) {
  await page.goto('/host');
  const app = page.frameLocator('#app');
  await expect(app.getByText('Try it with sample shops in Kajang')).toBeVisible();
  return app;
}

test('a customer books a cut, it survives a reload, then cancels it', async ({ page }) => {
  const app = await open(page);
  await snap(page, 'demo-01-welcome');
  await button(app, 'Try as a customer').click();

  await expect(app.getByText('Ali Barber Sungai Chua')).toBeVisible();
  await expect(app.getByText('Kemas Barber Kajang')).toBeVisible();
  await snap(page, 'demo-02-explore');
  await app.getByText('Ali Barber Sungai Chua').click();

  await app.getByText('Haircut', { exact: true }).click();
  await button(app, /^Tomorrow/).click();
  const time = app.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
  await expect(time).toBeVisible();
  await time.click();
  await snap(page, 'demo-03-shop');
  await button(app, 'Confirm booking').click();
  await expect(app.getByText('You’re booked!')).toBeVisible();
  await snap(page, 'demo-04-booked');

  await button(app, 'See my bookings').click();
  const booked = app.getByText(/^Haircut with (Ali|Danial) · RM20$/);
  await expect(booked).toBeVisible();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  await snap(page, 'demo-05-my-bookings');

  // Everything is kept in this browser, so a reload changes nothing.
  await page.reload();
  await page.frameLocator('#app').getByRole('tab', { name: /My bookings/ }).click();
  await expect(booked).toBeVisible();

  await button(app, 'Cancel').first().click();
  await expect(app.getByRole('alertdialog')).toBeVisible();
  await snap(page, 'demo-06-confirm');
  await app.getByRole('alertdialog').getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await expect(booked).toHaveCount(0);
  await expect(app.getByText('Cancelled', { exact: true }).first()).toBeVisible();
});

test('one tap across to the barber side, and the demo starts over cleanly', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();

  await expect(app.getByText('Bookings').first()).toBeVisible();
  await button(app, /^Tomorrow/).click();
  await expect(app.getByText('Hakim', { exact: true })).toBeVisible();
  await expect(app.getByText('“Same as last time”')).toBeVisible();
  await snap(page, 'demo-07-barber-day');

  await app.getByRole('tab', { name: /My shop/ }).click();
  await expect(app.getByText('You are live')).toBeVisible();
  await expect(app.getByText(/Free trial: 2\d days left/)).toBeVisible();
  await snap(page, 'demo-08-my-shop');

  // Pause bookings, then start over: the shop is live again.
  await button(app, 'Pause bookings').click();
  await expect(app.getByText('Not live yet')).toBeVisible();
  await button(app, 'See the customer side').click();
  await expect(app.getByText('Kemas Barber Kajang')).toBeVisible();
  await expect(app.getByText('Ali Barber Sungai Chua')).toHaveCount(0);

  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'Sign out').click();
  await button(app, 'Start the demo again').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Start again', exact: true }).click();
  await button(app, 'Try as a customer').click();
  await expect(app.getByText('Ali Barber Sungai Chua')).toBeVisible();
});
