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

  await app.getByRole('radio', { name: /^Haircut RM/ }).click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  const time = app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
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

test('the barber reminds tomorrow’s customers on WhatsApp', async ({ page, context }) => {
  // WhatsApp opens in a new tab; answer it here so nothing leaves the machine.
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const app = await open(page);
  await button(app, 'Try as a barber').click();

  // Today: a card says how many of tomorrow's customers nobody has reminded yet.
  await expect(app.getByText('Remind tomorrow’s customers')).toBeVisible();
  const left = app.getByText(/^\d+ still to remind$/);
  const before = Number((await left.textContent())?.split(' ')[0]);
  expect(before).toBeGreaterThanOrEqual(2);
  await snap(page, 'demo-09-remind-card');
  await button(app, /^Remind tomorrow’s customers/).click();
  await expect(app.getByText('Hakim', { exact: true })).toBeVisible();

  const opened = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  const whatsapp = await opened;
  await whatsapp.waitForLoadState();
  expect(new URL(whatsapp.url()).searchParams.get('text')).toBe(
    'Hi Hakim, a reminder from Ali Barber Sungai Chua: your Skin fade is tomorrow at 4:30 pm. ' +
      'Can’t make it? Just reply here so we can give the slot to someone else.',
  );
  await whatsapp.close();

  // The row says so quietly, and another reminder waits under More.
  await expect(app.getByText('✓ Reminded').first()).toBeVisible();
  await expect(button(app, 'Remind Hakim on WhatsApp')).toHaveCount(0);
  await button(app, 'More actions for Hakim').click();
  await expect(button(app, 'Remind again')).toBeVisible();
  await snap(page, 'demo-10-reminded');

  await app.getByRole('radio', { name: /^Today/ }).click();
  await expect(left).toHaveText(`${before - 1} still to remind`);
});

test('a reminder that can’t be saved still opens WhatsApp, and says so', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await expect(button(app, 'Remind Hakim on WhatsApp')).toBeVisible();
  const reminded = await app.getByText('✓ Reminded').count();

  // Meanwhile another phone in the shop cancels Hakim's booking.
  const other = await context.newPage();
  await other.goto('/host');
  const app2 = other.frameLocator('#app');
  await app2.getByRole('radio', { name: /^Tomorrow/ }).click();
  await button(app2, 'More actions for Hakim').click();
  await button(app2, 'Cancel booking').click();
  await app2.getByRole('alertdialog').getByRole('button', { name: 'Cancel and WhatsApp', exact: true }).click();
  await expect(app2.getByText('Booking cancelled. Let Hakim know.')).toBeVisible();
  await other.close();

  const opened = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  expect((await opened).url()).toMatch(/^https:\/\/wa\.me\/601122334455\?text=Hi%20Hakim/);
  await expect(app.getByRole('alert')).toHaveText(
    'Reminder for Hakim not saved. You can only remind a customer about an upcoming booking.',
  );
  await expect(button(app, 'Remind Hakim on WhatsApp')).toHaveCount(0);
  await expect(app.getByText('✓ Reminded')).toHaveCount(reminded);
});

test('one tap across to the barber side, and the demo starts over cleanly', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();

  await expect(app.getByText('Bookings').first()).toBeVisible();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await expect(app.getByText('Hakim', { exact: true })).toBeVisible();
  await expect(app.getByText('“Same as last time”')).toBeVisible();
  await snap(page, 'demo-07-barber-day');

  await app.getByRole('tab', { name: /My shop/ }).click();
  await expect(app.getByText('You are live')).toBeVisible();
  await expect(app.getByText(/Free trial: 2\d days left/)).toBeVisible();
  await snap(page, 'demo-08-my-shop');

  // Pause bookings, then start over: the shop is live again.
  await button(app, 'Pause bookings').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Pause bookings', exact: true }).click();
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
