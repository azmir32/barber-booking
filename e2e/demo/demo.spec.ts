import { devices, expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';

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
  // "Add to calendar" opens Google Calendar; it is answered here so the tests stay offline.
  await page.context().route('https://calendar.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Google Calendar</title>' }),
  );
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

const button = (app: FrameLocator | Page | Locator, name: string | RegExp) =>
  app.getByRole('button', { name, exact: typeof name === 'string' });
/** A shop in Find a barber's list, by the name heading its card; Hakim's own barbers above it say the names too. */
const listed = (app: FrameLocator | Page, name: string) => app.getByRole('heading', { name, exact: true });

async function open(page: Page) {
  await page.goto('/host');
  const app = page.frameLocator('#app');
  await expect(app.getByText('Try it with sample shops in Kajang')).toBeVisible();
  return app;
}

/** Presses an "Add to calendar" button and returns the Google Calendar link it opened in a new tab. */
async function addsToGoogleCalendar(page: Page, press: () => Promise<void>) {
  const [tab] = await Promise.all([page.context().waitForEvent('page'), press()]);
  await tab.waitForLoadState();
  const url = new URL(tab.url());
  await tab.close();
  expect(`${url.origin}${url.pathname}`).toBe('https://calendar.google.com/calendar/render');
  expect(url.searchParams.get('action')).toBe('TEMPLATE');
  expect(url.searchParams.get('dates')).toMatch(/^\d{8}T\d{6}Z\/\d{8}T\d{6}Z$/);
  expect(url.searchParams.get('ctz')).toBe('Asia/Kuala_Lumpur');
  return url.searchParams;
}

test('a customer books a cut, it survives a reload, then cancels it', async ({ page }) => {
  const app = await open(page);
  await snap(page, 'demo-01-welcome');
  await button(app, 'Try as a customer').click();

  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await snap(page, 'demo-02-explore');
  await listed(app, 'Ali Barber Sungai Chua').click();

  await app.getByRole('radio', { name: /^Haircut RM/ }).click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  const time = app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
  await expect(time).toBeVisible();
  await time.click();
  await snap(page, 'demo-03-shop');
  await button(app, 'Confirm booking').click();
  await expect(app.getByText('You’re booked!')).toBeVisible();
  await snap(page, 'demo-04-booked');
  // On Android, and in a frame like this one, it opens Google Calendar's add-event page.
  const event = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());
  expect(event.get('text')).toBe('Haircut at Ali Barber Sungai Chua');
  expect(event.get('location')).toBe('No. 12, Jalan Sungai Chua 3/1, 43000 Kajang');
  expect(event.get('details')).toMatch(/^Barber: (Ali|Danial)\nRM20 · Pay at the shop\.\n/);

  await button(app, 'See my bookings').click();
  const booked = app.getByText(/^Haircut with (Ali|Danial) · RM20$/);
  await expect(booked).toBeVisible();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  await snap(page, 'demo-05-my-bookings');
  // Each upcoming booking has the button too.
  await expect(button(app, 'Add to calendar')).toHaveCount(2);
  const fromList = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').last().click());
  expect(fromList.get('text')).toMatch(/^(Haircut|Skin fade) at Ali Barber Sungai Chua$/);

  // Everything is kept in this browser, so a reload changes nothing.
  await page.reload();
  await page.frameLocator('#app').getByRole('tab', { name: /My bookings/ }).click();
  await expect(booked).toBeVisible();

  // Each Cancel button says which booking it cancels.
  await expect(button(app, /^Cancel booking on /)).toHaveCount(2);
  await button(app, /^Cancel booking on /).first().click();
  await expect(app.getByRole('alertdialog')).toBeVisible();
  await expect(app.getByRole('alertdialog').getByText(/Added it to your calendar\? Delete it there too\.$/)).toBeVisible();
  await snap(page, 'demo-06-confirm');
  await app.getByRole('alertdialog').getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await expect(booked).toHaveCount(0);
  // It says it worked, and offers to tell the shop.
  const bar = app.getByRole('status').filter({ hasText: 'Booking cancelled.' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'WhatsApp the shop', exact: true })).toBeVisible();
  // Its time is still to come, so it is listed as cancelled, not as the newest of Earlier.
  await expect(app.getByRole('heading', { name: 'Cancelled', exact: true })).toBeVisible();
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
  // Later today's customers can be reminded too, but only from More.
  await expect(button(app, /^Remind .* on WhatsApp$/)).toHaveCount(0);

  // The message never went out after all: take it back, and Hakim counts again.
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await button(app, 'More actions for Hakim').click();
  await button(app, 'Undo “Reminded”').click();
  await expect(button(app, 'Remind Hakim on WhatsApp')).toBeVisible();
  await app.getByRole('radio', { name: /^Today/ }).click();
  await expect(left).toHaveText(`${before} still to remind`);
});

test('a reminder sent from a screen that missed a move says so, and the new time can have one', async ({
  page,
  context,
}) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const sent = async (opened: Promise<Page>) => {
    const whatsapp = await opened;
    await whatsapp.waitForLoadState();
    await whatsapp.close();
    return new URL(whatsapp.url()).searchParams.get('text');
  };
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await expect(button(app, 'Remind Hakim on WhatsApp')).toBeVisible();

  // Hakim moves his cut an hour earlier on his own phone; this screen hasn't reloaded yet.
  // (Not later: when tomorrow is a Monday, Danial is off and Wei Jie is in Ali's chair at 6 pm.)
  await page.evaluate(() => {
    const key = 'potongku.demo.v1';
    const saved = JSON.parse(localStorage.getItem(key)!);
    type Row = Record<string, string | null>;
    const hakim = (saved.tables.profiles as Row[]).find((p) => p.full_name === 'Hakim')!;
    const cut = (saved.tables.bookings as Row[]).find(
      (b) => b.customer_id === hakim.id && b.status === 'confirmed' && Date.parse(b.starts_at!) > Date.now(),
    )!;
    const earlier = (at: string | null) => new Date(Date.parse(at!) - 3_600_000).toISOString();
    Object.assign(cut, { starts_at: earlier(cut.starts_at), ends_at: earlier(cut.ends_at), reminded_at: null });
    localStorage.setItem(key, JSON.stringify(saved));
  });

  const opened = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  expect(await sent(opened)).toMatch(/is tomorrow at 4:30 pm\./);
  // The row now shows the new time, says the reminder wasn't saved, and still offers one.
  const notSaved = app.getByRole('alert');
  await expect(notSaved).toHaveText('Reminder not saved. This booking has changed. Check the new time.');
  await expect(app.getByText('3:30 pm', { exact: true })).toBeVisible();
  await snap(page, 'demo-11-reminder-not-saved');

  const again = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  expect(await sent(again)).toMatch(/is tomorrow at 3:30 pm\./);
  await expect(notSaved).toHaveCount(0);
  await expect(button(app, 'Remind Hakim on WhatsApp')).toHaveCount(0);
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
  // Hakim's row has gone to Cancelled, so the bar says it, and stays until it is seen.
  const notSaved = app.getByText('Reminder for Hakim not saved. You can only remind a customer about an upcoming booking.');
  await expect(notSaved).toBeVisible();
  await expect(button(app, 'Remind Hakim on WhatsApp')).toHaveCount(0);
  await expect(app.getByText('✓ Reminded')).toHaveCount(reminded);
  await page.waitForTimeout(9000);
  await expect(notSaved).toBeVisible();
  await button(app, 'OK').click();
  await expect(notSaved).toHaveCount(0);
});

test('the barber sees who is due for a cut and invites them back on WhatsApp', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('tab', { name: /My shop/ }).click();

  // My shop says how many customers there are, and how many are due.
  const card = app.getByRole('link', { name: /^Customers: \d+ customers · 4 due for a cut$/ });
  await expect(card).toBeVisible();
  await snap(page, 'demo-12-customers-card');
  await card.click();

  // Due for a cut comes first, longest overdue at the top, then everyone else.
  await expect(app.getByRole('heading', { name: 'Due for a cut' })).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Everyone' })).toBeVisible();
  await expect(app.getByText('Daniel Tan', { exact: true })).toBeVisible();
  await expect(app.getByText('016-778 2301', { exact: true })).toBeVisible();
  await expect(app.getByText('Last cut 6 weeks ago').first()).toBeVisible();
  await expect(app.getByText('3 visits · Comes about every 4 weeks').first()).toBeVisible();
  // Those due get an invite, and so does Mr Wong, away too long to be listed as due.
  // Everyone with a number can still be messaged or called.
  await expect(button(app, /^Invite .* to book on WhatsApp$/)).toHaveCount(5);
  await expect(button(app, 'Invite Mr Wong to book on WhatsApp')).toBeVisible();
  await expect(button(app, 'Call Mr Wong')).toBeVisible();
  // Walk-ins added with no name are not a customer.
  await expect(app.getByText('Walk-in', { exact: true })).toHaveCount(0);
  // Hakim is booked tomorrow, with the time kept on one line.
  await expect(app.getByText(/^Booked .* at 4:30\u00a0pm$/)).toBeVisible();
  await snap(page, 'demo-13-customers');

  const opened = context.waitForEvent('page');
  await button(app, 'Invite Daniel Tan to book on WhatsApp').click();
  const whatsapp = await opened;
  await whatsapp.waitForLoadState();
  const url = new URL(whatsapp.url());
  await whatsapp.close();
  expect(url.pathname).toBe('/60167782301');
  expect(url.searchParams.get('text')).toMatch(
    /^Hi Daniel Tan, it’s been 6 weeks since your last cut at Ali Barber Sungai Chua\. Want to book a time\? https?:\/\/\S+\/shop\/ali-barber$/,
  );
  // The row remembers it, so nobody gets asked twice by mistake.
  await expect(app.getByText('✓ Invited today')).toBeVisible();
  await expect(button(app, 'Invite Daniel Tan to book on WhatsApp')).toHaveText(/Invite again$/);
  // One that never went out (WhatsApp closed without sending) can be taken back.
  await button(app, 'Undo the invite to Daniel Tan').click();
  await expect(app.getByText('✓ Invited today')).toHaveCount(0);
  await expect(button(app, 'Invite Daniel Tan to book on WhatsApp')).toHaveText(/Invite on WhatsApp$/);

  // Search finds a number however it is typed.
  await app.getByLabel('Search', { exact: true }).fill('012-688');
  await expect(app.getByText('Encik Kamal', { exact: true })).toBeVisible();
  await expect(app.getByText('012-688 4521', { exact: true })).toBeVisible();
  await expect(app.getByText('Daniel Tan', { exact: true })).toHaveCount(0);
  await expect(app.getByText('1 customer · 1 due for a cut')).toBeVisible();
});

test('a new barber with a taken link gets one to try, and can carry on as a customer instead', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Set up my shop').click();
  await app.getByLabel('Full name', { exact: true }).fill('Hafiz');
  await app.getByLabel('Phone (WhatsApp)', { exact: true }).fill('012-999 8888');
  await app.getByLabel('Email', { exact: true }).fill('hafiz@test.my');
  await app.getByLabel('Password', { exact: true }).fill('password123');
  await button(app, 'Create account').click();
  await expect(app.getByText('Set up your shop')).toBeVisible();
  await expect(app.getByText('Signed in as hafiz@test.my')).toBeVisible();

  // A common name's link is taken: the link field says so and offers another.
  await app.getByLabel('Shop name', { exact: true }).fill('Ali Barber');
  await button(app, 'Create my shop').click();
  await expect(app.getByText('“ali-barber” is taken by another shop. Try another link.')).toBeVisible();
  await button(app, 'Use ali-barber-kajang').click();
  await expect(app.getByLabel('Booking link', { exact: true })).toHaveValue('ali-barber-kajang');
  await expect(app.getByText(/is taken by another shop/)).toHaveCount(0);
  await snap(page, 'demo-17-link-taken');

  // Picked "Barber / shop owner" by mistake: a way out, without a shop left behind.
  await button(app, 'I’m a customer, not a barber').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Yes, I’m a customer', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Ali Barber Sungai Chua' })).toBeVisible();
  await app.getByRole('tab', { name: /Account/ }).click();
  await expect(app.getByText('hafiz@test.my')).toBeVisible();
});

test('a new shop is walked to its first booking, and the steps go once it is ready', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const app = await open(page);
  await button(app, 'Set up my shop').click();
  await app.getByLabel('Full name', { exact: true }).fill('Nizam');
  await app.getByLabel('Phone (WhatsApp)', { exact: true }).fill('012-777 4321');
  await app.getByLabel('Email', { exact: true }).fill('nizam@test.my');
  await app.getByLabel('Password', { exact: true }).fill('password123');
  await button(app, 'Create account').click();
  await app.getByLabel('Shop name', { exact: true }).fill('Nizam Cuts Kajang');
  await button(app, 'Create my shop').click();

  // Straight to My shop, with every step still to do.
  const step = (title: string, state: 'done' | 'not done yet') => button(app, new RegExp(`^${title}, ${state}\\.`));
  await expect(app.getByText('Get your shop ready')).toBeVisible();
  await expect(app.getByText('0 of 4 done')).toBeVisible();
  await expect(step('Add your services', 'not done yet')).toBeVisible();
  // Steps for later show their names only; what to do is still read out.
  await expect(step('Add your barbers and their hours', 'not done yet')).toHaveAccessibleName(
    /Set Nizam’s working hours, so customers can pick a time\.$/,
  );
  await expect(step('Add your services', 'not done yet')).toContainText(
    'What you offer, with prices, so customers have something to book.',
  );
  await expect(step('Set where the shop is \\(optional\\)', 'not done yet')).toBeVisible();
  await expect(step('Go live', 'not done yet')).toBeVisible();
  await expect(step('Share your booking link', 'not done yet')).toBeVisible();
  await snap(page, 'demo-34-ready-new-shop');

  // Go live with nothing to book says what is missing instead.
  await button(app, 'Go live').click();
  let dialog = app.getByRole('alertdialog');
  await expect(dialog.getByText('Not ready to go live yet')).toBeVisible();
  await expect(
    dialog.getByText('Customers would have nothing to book yet. Add a service and set your working hours first.'),
  ).toBeVisible();
  await snap(page, 'demo-35-ready-not-yet');
  await button(dialog, 'Not now').click();
  await expect(app.getByText('Not live yet')).toBeVisible();

  // Each step opens where it is done.
  await step('Add your services', 'not done yet').click();
  await button(app, '+ Haircut RM20').click();
  await expect(app.getByText('Your menu')).toBeVisible();
  await app.getByRole('tab', { name: /My shop/ }).click();
  await expect(app.getByText('1 of 4 done')).toBeVisible();
  await expect(step('Add your services', 'done')).toContainText('1 service on your menu');

  // Still no times to pick: Go live goes to the first chair's hours, filled in to start from.
  await button(app, 'Go live').click();
  dialog = app.getByRole('alertdialog');
  await expect(dialog.getByText('Customers would have no times to pick. Set Nizam’s working hours first.')).toBeVisible();
  await button(dialog, 'Set hours').click();
  await expect(
    app.getByText('These are suggested hours, not saved yet. Change them to yours, then tap Save hours.'),
  ).toBeVisible();
  await snap(page, 'demo-36-ready-hours');
  await button(app, 'Save hours').click();
  await expect(app.getByText('2 of 4 done')).toBeVisible();
  await expect(step('Add your barbers and their hours', 'done')).toContainText('Hours set for Nizam');
  await expect(app.getByText('Your services and hours are set. Go live when you’re ready.')).toBeVisible();

  await button(app, 'Go live').click();
  await expect(app.getByText('You are live')).toBeVisible();
  await expect(app.getByText('3 of 4 done')).toBeVisible();
  await expect(step('Go live', 'done')).toBeVisible();
  await snap(page, 'demo-37-ready-live');

  // Sharing the link is the last step: the card says the shop is ready, once.
  await button(app, 'Copy').click();
  await expect(button(app, 'Copied')).toBeVisible();
  await expect(app.getByText('Your shop is ready.')).toBeVisible();
  await expect(app.getByText('Customers can book you now.')).toBeVisible();
  await expect(app.getByText('Get your shop ready')).toHaveCount(0);
  await snap(page, 'demo-38-ready-done');
  await button(app, 'Got it').click();
  await expect(app.getByText('Your shop is ready.')).toHaveCount(0);

  // Gone for good, after the app opens again too.
  await page.reload();
  await app.getByRole('tab', { name: /My shop/ }).click();
  await expect(app.getByText('You are live')).toBeVisible();
  await expect(app.getByText('Get your shop ready')).toHaveCount(0);
  await expect(app.getByText('Your shop is ready.')).toHaveCount(0);
});

test('closing over bookings shows who is booked, and the barber cancels and tells them first', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('tab', { name: /My shop/ }).click();
  await button(app, 'Close for a few days').click();

  // Nothing to press until a day is picked, and days with customers coming say so.
  await expect(button(app, 'Pick the first day')).toBeDisabled();
  await app.getByRole('radio', { name: /^Tomorrow \d+ \w+ \d+ booked$/ }).click();
  await expect(app.getByRole('heading', { name: /^\d+ bookings? on these days$/ })).toBeVisible();
  await expect(app.getByText(/^Cancel the (booking|\d+ bookings) on these days first\.$/)).toBeVisible();
  await expect(button(app, 'Close for 1 day')).toBeDisabled();
  await snap(page, 'demo-16-close-over-bookings');

  // Hakim's cut is cancelled here, and he can be told on WhatsApp straight after.
  await button(app, /^Cancel Hakim’s booking on /).click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Cancel and WhatsApp', exact: true }).click();
  await expect(button(app, /^Cancel Hakim’s booking on /)).toHaveCount(0);
  await expect(button(app, 'WhatsApp Hakim')).toHaveText(/Let them know$/);
  const opened = context.waitForEvent('page');
  await button(app, 'WhatsApp Hakim').click();
  const whatsapp = await opened;
  await whatsapp.waitForLoadState();
  const text = new URL(whatsapp.url()).searchParams.get('text');
  await whatsapp.close();
  expect(text).toMatch(/^Hi Hakim, sorry, Ali Barber Sungai Chua has to cancel your Skin fade on .+ at 4:30 pm\. /);

  // Once nobody is left, the shop closes for the day.
  const cancels = app.getByRole('button', { name: /^Cancel .*’s booking on / });
  while ((await cancels.count()) > 0) {
    const before = await cancels.count();
    await cancels.first().click();
    await app.getByRole('alertdialog').getByRole('button', { name: /^Cancel (and WhatsApp|booking)$/ }).click();
    await expect(cancels).toHaveCount(before - 1);
  }
  await expect(app.getByRole('heading', { name: 'Bookings cancelled' })).toBeVisible();
  await expect(app.getByText(/^You’ll be closed /)).toBeVisible();
  await app.getByLabel('Reason (optional)', { exact: true }).fill('Kenduri');
  await button(app, 'Close for 1 day').click();
  await expect(app.getByText('Kenduri', { exact: true })).toBeVisible();
});

test('a returning customer sees their next cut and their barbers, and books the same again in one tap', async ({
  page,
}) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();

  // His skin fade tomorrow comes first.
  const next = app.getByRole('link', {
    name: /^Your next cut: Tomorrow, 4:30 pm, Skin fade with (Ali|Danial) at Ali Barber Sungai Chua$/,
  });
  await expect(next).toBeVisible();
  // Then his barbers, latest first, each with the cut he had there.
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toBeVisible();
  const lastCuts = app.getByText(/^(Haircut|Skin fade) with \w+, (\d+ days|\d+ weeks|\d+ months) ago$/);
  await expect(lastCuts).toHaveText([
    /^Haircut with Rahman, 1[12] days ago$/,
    /^Haircut with (Ali|Danial), 4 weeks ago$/,
    'Skin fade with Irfan, 2 months ago',
  ]);
  await expect(button(app, /^Book again at /)).toHaveCount(3);
  // His cut is booked, so none of them says he is due.
  await expect(app.getByText('Due for a cut')).toHaveCount(0);
  await expect(app.getByRole('heading', { name: 'All barbers' })).toBeVisible();
  await snap(page, 'demo-02b-returning');

  // Searching, or picking an area, is looking for something else: the list alone.
  await app.getByLabel('Search', { exact: true }).fill('fade');
  await expect(listed(app, 'The Fade Room')).toBeVisible();
  await expect(next).toHaveCount(0);
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toHaveCount(0);
  await app.getByLabel('Search', { exact: true }).fill('');
  await expect(next).toBeVisible();
  await app.getByRole('radio', { name: 'Kajang town', exact: true }).click();
  await expect(app.getByText('Showing barbers in Kajang town')).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toHaveCount(0);
  // Opening the app again, the area he picked still filters the list, with his own cut and barbers on top.
  await page.reload();
  await expect(app.getByText('Showing barbers in Kajang town')).toBeVisible();
  await expect(next).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Barbers in Kajang town' })).toBeVisible();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toHaveCount(0);
  await button(app, 'Show all').click();
  await expect(app.getByRole('heading', { name: 'All barbers' })).toBeVisible();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();

  // The next cut opens My bookings.
  await next.click();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  await app.getByRole('tab', { name: /Barbers/ }).click();

  // Book again opens the shop on the same service and barber, ready to pick a time.
  await button(app, 'Book again at Kemas Barber Kajang').click();
  await expect(app.getByRole('radio', { name: /^Haircut RM18/ })).toBeChecked();
  await expect(app.getByRole('radio', { name: 'Rahman', exact: true })).toBeChecked();
  await expect(app.getByRole('radio', { name: 'Any barber', exact: true })).not.toBeChecked();
  await expect(app.getByRole('heading', { name: '3. Pick a time' })).toBeVisible();
  await snap(page, 'demo-02c-book-again');
});

test('a customer moves their cut, and can put the new time in their calendar', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  const before = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());

  await button(app, 'Change time').click();
  await expect(app.getByText('Changing your booking')).toBeVisible();
  // The booking's own time is marked as current, so the first plain time is a new one.
  await app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first().click();
  await button(app, 'Move to this time').click();
  await expect(app.getByText('Booking moved')).toBeVisible();
  await expect(app.getByText('Added it to your calendar before? Delete the old one there.')).toBeVisible();
  await snap(page, 'demo-06b-moved');
  const after = await addsToGoogleCalendar(page, () => button(app, 'Add to calendar').click());
  expect(after.get('text')).toBe('Skin fade at Ali Barber Sungai Chua');
  expect(after.get('dates')).not.toBe(before.get('dates'));
});

test('the shop moves a booking when the customer calls, and tells them the new time', async ({ page, context }) => {
  await context.route('https://wa.me/**', (route) => route.fulfill({ contentType: 'text/plain', body: 'WhatsApp' }));
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await button(app, 'More actions for Hakim').click();
  await button(app, 'Change time for Hakim').click();

  // The same barber's free times, without the time Hakim has now.
  const time = app.getByRole('radiogroup', { name: /^Free times for / }).getByRole('radio').first();
  await expect(time).toBeVisible();
  const movedTo = (await time.textContent()) ?? '';
  expect(movedTo).not.toBe('4:30 pm');
  await time.click();
  await button(app, 'Move to this time').click();
  await expect(app.getByText('Booking moved')).toBeVisible();
  await expect(app.getByText(/^Was .* at 4:30 pm\.$/)).toBeVisible();
  await snap(page, 'demo-10b-shop-moved');

  const opened = context.waitForEvent('page');
  await button(app, 'Let Hakim know on WhatsApp').click();
  const whatsapp = await opened;
  await whatsapp.waitForLoadState();
  expect(new URL(whatsapp.url()).searchParams.get('text')).toMatch(
    new RegExp(`^Hi Hakim, this is Ali Barber Sungai Chua\\. Your Skin fade is now on .+ at ${movedTo}\\. See you then!$`),
  );
  await whatsapp.close();
  await button(app, 'Done').click();
  // Still Hakim's booking, at the new time, and due a reminder for it.
  await expect(button(app, 'Remind Hakim on WhatsApp')).toBeVisible();
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
  // Set up long ago: no steps to get ready.
  await expect(app.getByText('Get your shop ready')).toHaveCount(0);
  await snap(page, 'demo-08-my-shop');

  // Pause bookings, then start over: the shop is live again.
  await button(app, 'Pause bookings').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Pause bookings', exact: true }).click();
  // Paused, not new: bookings already made still stand.
  await expect(app.getByText('Bookings paused')).toBeVisible();
  await expect(button(app, 'Turn bookings back on')).toBeVisible();
  await expect(app.getByText('Get your shop ready')).toHaveCount(0);
  await button(app, 'See the customer side').click();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toHaveCount(0);
  // Still one of Hakim's barbers, saying it isn't taking bookings instead of offering Book again.
  await expect(app.getByText('Not taking online bookings right now')).toBeVisible();
  await expect(button(app, 'Book again at Ali Barber Sungai Chua')).toHaveCount(0);
  await expect(button(app, 'Book again at Kemas Barber Kajang')).toBeVisible();
  // Hakim's booking there still stands: he still sees where to go and how to reach them,
  // but can't move it online.
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(
    app.getByText('Online booking is paused at this shop. Your booking still stands; WhatsApp them if unsure.'),
  ).toBeVisible();
  await expect(app.getByText(/^Ali Barber Sungai Chua · No\. 12, Jalan Sungai Chua/)).toBeVisible();
  await expect(app.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();
  await expect(button(app, 'Directions')).toBeVisible();
  await expect(button(app, 'WhatsApp the shop')).toBeVisible();
  await expect(button(app, 'Change time')).toHaveCount(0);
  await snap(page, 'demo-08b-bookings-shop-paused');

  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'Sign out').click();
  await button(app, 'Start the demo again').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Start again', exact: true }).click();
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
});

test('the owner sees this week’s takings, and last week’s and the month’s', async ({ page }) => {
  // The narrowest phone the app is made for.
  await page.setViewportSize({ width: 360, height: 760 });
  const app = await open(page);
  await button(app, 'Try as a barber').click();
  await app.getByRole('tab', { name: /My shop/ }).click();

  // Under the shop's status, the week so far in one line.
  const card = app.getByRole('link', {
    name: /^Takings: This week: (RM[\d,.]+ from \d+ cuts?|no cuts marked done yet)$/,
  });
  await expect(card).toBeVisible();
  await snap(page, 'demo-12-takings-card');
  await card.click();

  const periods = app.getByRole('radiogroup', { name: 'Show takings for' });
  await expect(periods.getByRole('radio', { name: 'This week' })).toBeChecked();
  await expect(app.getByText('Money in', { exact: true })).toBeVisible();
  // While the week runs, it is compared with the week before up to this time,
  // and the days chart only has the days the week has reached.
  await expect(app.getByText(/this time last week$/)).toHaveCount(2);
  await expect(
    app.getByRole('img', { name: /^Average bookings a day: Monday: \d+(, [A-Z][a-z]+day: \d+){0,6}$/ }),
  ).toBeVisible();
  await expect(app.getByRole('img', { name: /^Bookings by hour: \d{1,2}:00 (am|pm): \d+/ })).toBeVisible();
  await snap(page, 'demo-13-takings-week');

  // Last week is all in the past: money, both barbers and the top services.
  await periods.getByRole('radio', { name: 'Last week' }).click();
  await expect(periods.getByRole('radio', { name: 'Last week' })).toBeChecked();
  await expect(app.getByText(/the week before$/)).toHaveCount(2);
  await expect(
    app.getByRole('img', {
      name: /^Average bookings a day: Monday: \d+, Tuesday: \d+, Wednesday: \d+, Thursday: \d+, Friday: \d+, Saturday: \d+, Sunday: \d+$/,
    }),
  ).toBeVisible();
  await expect(app.getByText(/^RM[1-9][\d,]*(\.\d\d)?$/).first()).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Barbers', exact: true })).toBeVisible();
  await expect(app.getByText(/^\d+ cuts?( · \d+ no-shows?)?$/)).toHaveCount(2);
  await expect(app.getByRole('heading', { name: 'Top services' })).toBeVisible();
  await expect(app.getByText(/^Haircut$/)).toBeVisible();

  // The month is named, and compared with last month up to the same day.
  await periods.getByRole('radio', { name: 'This month' }).click();
  const month = new Intl.DateTimeFormat('en-MY', { month: 'long', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur' });
  await expect(app.getByRole('heading', { name: month.format(new Date()) })).toBeVisible();
  await expect(app.getByText(/this time last month$/)).toHaveCount(2);
  await snap(page, 'demo-14-takings-month');
  await page.emulateMedia({ colorScheme: 'dark' });
  await snap(page, 'demo-15-takings-month-dark');
});

test('the barber sees what customers changed since they last looked, and clears it with Got it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const app = await open(page);
  await button(app, 'Try as a barber').click();

  // The sample shop's last few hours, newest first: a booking, a cancellation and a move.
  const card = app.getByRole('heading', { name: 'Since you last looked' });
  await expect(card).toBeVisible();
  const tab = app.getByRole('tab', { name: 'Bookings, 3 changes since you last looked', exact: true });
  await expect(tab).toContainText('3');
  const lines = app.getByRole('button', { name: /^\S+ (booked|cancelled|moved) / });
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveAccessibleName(
    /^Aiman booked Haircut \+ beard for \w{3},\s\d{1,2}\s\w{3}\sat\s\d{1,2}:\d\d\s[ap]m with (Ali|Danial)\. 1\shr\sago$/,
  );
  await expect(lines.nth(1)).toHaveAccessibleName(
    /^Jason cancelled (today|tomorrow) at \d{1,2}:\d\d\s[ap]m with (Ali|Danial), so that chair is free\. 3\shr\sago$/,
  );
  await expect(lines.nth(2)).toHaveAccessibleName(/^Ravi moved to .+ with (Ali|Danial)\. 5\shr\sago$/);
  await snap(page, 'demo-18-since-you-last-looked');

  // A line opens its day with the booking in view, and the booking says it is new.
  const [, weekday, date] = /for (\w{3}),\s(\d{1,2}\s\w{3})\sat/.exec((await lines.nth(0).getAttribute('aria-label')) ?? '')!;
  const day = `${weekday}, ${date.replace(/\s/, ' ')}`;
  await lines.nth(0).click();
  await expect(app.getByRole('heading', { name: day, exact: true })).toBeVisible();
  const isNew = app.getByText('New', { exact: true });
  await expect(isNew).toBeInViewport();
  await expect(app.getByText('Aiman', { exact: true })).toBeInViewport();
  await snap(page, 'demo-19-new-booking');
  // A cancellation opens the folded list at the bottom of its day.
  await lines.nth(1).click();
  await expect(app.getByRole('radio', { name: /^(Today|Tomorrow)/, checked: true })).toBeVisible();
  await expect(app.getByText('Cancelled', { exact: true })).toBeInViewport();
  await snap(page, 'demo-20-cancelled-chair');

  // Got it clears the card, the tab's number and the New on the booking.
  await button(app, 'Got it').click();
  await expect(card).toHaveCount(0);
  await expect(tab).toHaveCount(0);
  const plainTab = app.getByRole('tab', { name: /Bookings$/ });
  await expect(plainTab).toBeVisible();
  await expect(plainTab).not.toContainText(/\d/);
  await app.getByRole('radio', { name: new RegExp(`^${weekday}\\s*${date.replace(/\s/, ' ')}$`) }).click();
  await expect(app.getByRole('heading', { name: day, exact: true })).toBeVisible();
  await expect(app.getByText('Aiman', { exact: true })).toBeVisible();
  await expect(isNew).toHaveCount(0);

  // Hakim books: this phone counts from the newest change it saw, which it keeps.
  await app.getByRole('tab', { name: /My shop/ }).click();
  await button(app, 'See the customer side').click();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await listed(app, 'Ali Barber Sungai Chua').click();
  await app.getByRole('radio', { name: /^Haircut RM/ }).click();
  await app.getByRole('radio', { name: /^Tomorrow/ }).click();
  await app.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first().click();
  await button(app, 'Confirm booking').click();
  await expect(app.getByText('You’re booked!')).toBeVisible();
  await button(app, 'See my bookings').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();
  await expect(app.getByRole('tab', { name: 'Bookings, 1 change since you last looked', exact: true })).toBeVisible();
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toHaveAccessibleName(/^Hakim booked Haircut for tomorrow at .+ with (Ali|Danial)\. Just\snow$/);

  // Starting the demo again brings back all the sample changes, though this phone saw newer ones.
  await button(app, 'Got it').click();
  await expect(card).toHaveCount(0);
  await app.getByRole('tab', { name: /My shop/ }).click();
  await button(app, 'See the customer side').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'Sign out').click();
  await button(app, 'Start the demo again').click();
  await app.getByRole('alertdialog').getByRole('button', { name: 'Start again', exact: true }).click();
  await button(app, 'Try as a barber').click();
  await expect(tab).toBeVisible();
  await expect(lines).toHaveCount(3);
});

test('a customer rates their cut, it shows on the shop’s page, and the owner replies', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();

  // A shop with a few reviews shows its stars in the list.
  const stars = app.getByRole('link', { name: /Kemas Barber Kajang/ }).getByRole('img', { name: /^Rated / });
  await expect(stars).toBeVisible();
  const before = /^Rated \d\.\d out of 5 from (\d+) reviews$/.exec((await stars.getAttribute('aria-label')) ?? '');
  expect(before).not.toBeNull();
  const count = Number(before![1]);

  // Hakim's cut at Kemas is done and not rated yet, so My bookings asks about it.
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(app.getByRole('heading', { name: 'Rate your cut', exact: true })).toBeVisible();
  await expect(app.getByText('How was your cut?')).toBeVisible();
  const picker = app.getByRole('radiogroup', { name: 'Your rating' });
  await expect(picker.getByRole('radio')).toHaveCount(5);
  await picker.getByRole('radio', { name: '5 stars', exact: true }).click();
  await expect(picker.getByRole('radio', { name: '5 stars', exact: true })).toBeChecked();
  await app.getByLabel('Comment (optional)', { exact: true }).fill('Clean fade, and no wait at all.');
  // Before it goes up, the form says which name it shows, and that can be changed.
  await expect(app.getByText('Shown on the shop’s page as “Hakim”.', { exact: true })).toBeVisible();
  await snap(page, 'demo-21-rate-cut');
  await button(app, 'Change name').click();
  await expect(app.getByLabel('Name on your review', { exact: true })).toHaveValue('Hakim');
  await button(app, 'Send').click();
  await expect(app.getByText('Thanks! Your rating is saved.')).toBeVisible();
  await expect(app.getByText('“Clean fade, and no wait at all.”')).toBeVisible();
  // It can still be changed for a while, up to the cut's own time 14 days on.
  await expect(button(app, /^Change your rating for /)).toBeVisible();
  await expect(app.getByText(/^You can change it until .+ at \d{1,2}:\d\d\s[ap]m\.$/)).toBeVisible();

  // On the shop's page it is the newest review, with his name.
  await app.getByRole('tab', { name: /Barbers/ }).click();
  await app.getByRole('link', { name: /^Kemas Barber Kajang/ }).click();
  const summary = app.getByRole('link', { name: new RegExp(`^Rated \\d\\.\\d out of 5 from ${count + 1} reviews\\. See reviews$`) });
  await expect(summary).toBeVisible();
  // A 44pt target, though its line is shorter.
  expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // With a service picked the steps open above the reviews, and See reviews still lands on them.
  await app.getByRole('radio', { name: /^Haircut RM/ }).click();
  await expect(app.getByRole('heading', { name: /Pick a time$/ })).toBeVisible();
  await expect(app.getByRole('progressbar', { name: 'Loading free times' })).toHaveCount(0);
  await summary.click();
  const reviews = app.getByRole('heading', { name: 'Reviews', exact: true });
  await expect(reviews).toBeVisible();
  await expect.poll(async () => (await reviews.boundingBox())?.y).toBeLessThan(200);
  await expect.poll(async () => (await reviews.boundingBox())?.y).toBeGreaterThan(0);
  await expect(app.getByText('Clean fade, and no wait at all.', { exact: true })).toBeVisible();
  await expect(app.getByText('Hakim', { exact: true })).toBeVisible();
  await snap(page, 'demo-22-shop-reviews');

  // Ali finds his shop's reviews on My shop, and answers one.
  await page.reload();
  await page.frameLocator('#app').getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();
  await app.getByRole('tab', { name: /My shop/ }).click();
  const card = app.getByRole('link', { name: /^Reviews: Rated \d\.\d out of 5 from \d+ reviews\. \S+: “.+”$/ });
  await expect(card).toBeVisible();
  await card.click();
  const reply = button(app, /^Reply to /).first();
  await expect(reply).toBeVisible();
  const name = ((await reply.getAttribute('aria-label')) ?? '').replace('Reply to ', '');
  await reply.click();
  await app.getByLabel('Your reply', { exact: true }).fill(`Thanks ${name}, see you next time!`);
  await button(app, 'Save reply').click();
  await expect(app.getByText('Reply saved.')).toBeVisible();
  await expect(app.getByText(`Thanks ${name}, see you next time!`, { exact: true })).toBeVisible();
  await expect(button(app, `Edit your reply to ${name}`)).toBeVisible();
  await snap(page, 'demo-23-owner-reviews');
});

/** Answers Google Maps here, so the tests stay offline, and returns what a press of `press` opened it at. */
async function opensGoogleMaps(page: Page, press: () => Promise<void>) {
  await page.context().route('https://www.google.com/maps/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Google Maps</title>' }),
  );
  const [tab] = await Promise.all([page.context().waitForEvent('page'), press()]);
  await tab.waitForLoadState();
  const url = new URL(tab.url());
  await tab.close();
  expect(`${url.origin}${url.pathname}`).toBe('https://www.google.com/maps/search/');
  return url.searchParams.get('query');
}

test('Near me puts the closest barbers first, says how far each is, and is kept for next time', async ({
  page,
  context,
}) => {
  // Standing in Sungai Chua, about 500 m from Ali's.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 2.9833, longitude: 101.7667 });
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  const nearMe = app.getByRole('radio', { name: 'Near me', exact: true });
  await expect(nearMe).not.toBeChecked();

  await nearMe.click();
  await expect(nearMe).toBeChecked();
  await expect(app.getByRole('radio', { name: 'All areas', exact: true })).not.toBeChecked();
  // Tapped on this visit, so it's the list alone, like picking an area.
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toHaveCount(0);
  const shopNames = app.getByRole('heading', { level: 2 });
  await expect(shopNames).toHaveText(['Ali Barber Sungai Chua', 'Kemas Barber Kajang', 'Gunting Pak Mat', 'The Fade Room']);
  const distances = app.getByRole('img', { name: / away$/ });
  await expect(distances).toHaveCount(4);
  await expect(distances.first()).toHaveAccessibleName('500 m away');
  await expect(distances.nth(1)).toHaveAccessibleName('2.6 km away');
  await snap(page, 'demo-24-near-me');

  // A search still filters, and what it finds stays nearest first.
  await app.getByLabel('Search', { exact: true }).fill('barber');
  await expect(shopNames).toHaveText(['Ali Barber Sungai Chua', 'Kemas Barber Kajang']);
  await app.getByLabel('Search', { exact: true }).fill('');
  await expect(shopNames).toHaveCount(4);

  // The shop's page says how far it is too, and Directions go to the point its owner set.
  await listed(app, 'Ali Barber Sungai Chua').click();
  await expect(app.getByRole('img', { name: '500 m away', exact: true })).toBeVisible();
  await snap(page, 'demo-25-near-me-shop');
  expect(await opensGoogleMaps(page, () => button(app, 'Directions').click())).toBe('2.9846,101.7712');

  // Opening the app again in Kajang town, Near me asks afresh: Kemas is now the closest.
  await context.setGeolocation({ latitude: 2.993, longitude: 101.788 });
  // The position is slow to come, as indoors.
  await page.addInitScript(() => {
    const geo = navigator.geolocation;
    const now = geo.getCurrentPosition.bind(geo);
    geo.getCurrentPosition = (found, failed, options) => void setTimeout(() => now(found, failed, options), 3000);
  });
  await page.reload();
  // Kept from last time, so his next cut and barbers are back on top at once, not after the position.
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toBeVisible();
  await expect(app.getByText('Finding where you are…')).toBeVisible();
  await expect(nearMe).toBeChecked();
  // Then the list, nearest first under them.
  await expect(app.getByRole('heading', { name: 'Barbers near you' })).toBeVisible();
  await expect(app.getByText('Finding where you are…')).toHaveCount(0);
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toBeVisible();
  await expect(distances.first()).toHaveAccessibleName('100 m away');
  await expect(app.getByRole('link', { name: /^Kemas Barber Kajang\s*100 m away/ })).toBeVisible();

  // An area is the other choice: picking one turns Near me off, and that is what is kept.
  await app.getByRole('radio', { name: 'Sungai Chua', exact: true }).click();
  await expect(nearMe).not.toBeChecked();
  await expect(app.getByText('Showing barbers in Sungai Chua')).toBeVisible();
  await expect(distances).toHaveCount(0);
  await page.reload();
  await expect(app.getByText('Showing barbers in Sungai Chua')).toBeVisible();
  await expect(nearMe).not.toBeChecked();
});

test('Near me says how to allow location when the browser blocks it, and the list stays as it was', async ({
  page,
  context,
}) => {
  await context.clearPermissions();
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await app.getByRole('radio', { name: 'Near me', exact: true }).click();
  await expect(
    app.getByText('Your browser is blocking location. Allow it for this site, then tap Near me again.'),
  ).toBeVisible();
  await expect(app.getByRole('radio', { name: 'Near me', exact: true })).not.toBeChecked();
  await expect(app.getByRole('radio', { name: 'All areas', exact: true })).toBeChecked();
  await expect(app.getByRole('heading', { name: 'Your barbers' })).toBeVisible();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await expect(app.getByRole('img', { name: / away$/ })).toHaveCount(0);
  await snap(page, 'demo-26-near-me-blocked');
  // Nothing was kept: the next visit is the usual list, without asking.
  await page.reload();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  await expect(app.getByRole('radio', { name: 'Near me', exact: true })).not.toBeChecked();
  await expect(app.getByText(/blocking location/)).toHaveCount(0);
});

test('the owner sets where the shop is from inside it, and checks it on the map', async ({ page, context }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();
  await app.getByRole('tab', { name: /My shop/ }).click();

  const location = app.getByRole('group', { name: 'Shop location' });
  await expect(location.getByText('Location set')).toBeVisible();
  await location.getByRole('button', { name: 'Remove the shop location' }).click();
  await expect(location.getByText('Not saved yet. Tap Save changes below.')).toBeVisible();

  // Deep inside, the phone only knows the spot to within 1.5 km: not good enough for every customer's Directions.
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 2.97, longitude: 101.76, accuracy: 1500 });
  await button(location, 'Use my location here').click();
  await expect(
    location.getByText('Couldn’t get your exact spot. Try again near the door or just outside.'),
  ).toBeVisible();
  await expect(location.getByText('Location set')).toHaveCount(0);
  await snap(page, 'demo-28-shop-location-rough');

  // At the shop's door, a few metres from where it was.
  await context.setGeolocation({ latitude: 2.98463, longitude: 101.77125 });
  await button(location, 'Use my location here').click();
  await expect(location.getByText('Location set')).toBeVisible();
  await expect(location.getByText(/exact spot/)).toHaveCount(0);
  await expect(location.getByText('Not saved yet. Tap Save changes below.')).toBeVisible();
  await snap(page, 'demo-27-shop-location');
  await button(app, 'Save changes').click();
  await expect(app.getByText('Saved.')).toBeVisible();
  await expect(location.getByText('Not saved yet. Tap Save changes below.')).toHaveCount(0);
  expect(await opensGoogleMaps(page, () => button(location, 'Check on the map').click())).toBe('2.98463,101.77125');

  // Customers' Directions now go there.
  await button(app, 'See the customer side').click();
  await listed(app, 'Ali Barber Sungai Chua').click();
  expect(await opensGoogleMaps(page, () => button(app, 'Directions').click())).toBe('2.98463,101.77125');
});

test('framed by another site that doesn’t share location, Near me and the shop location say it isn’t available there', async ({
  page,
  context,
}) => {
  // Allowed for the browser, but the site holding the demo doesn't pass it on (no allow="geolocation").
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 2.9833, longitude: 101.7667 });
  await page.goto('/embed');
  const app = page.frameLocator('#app');
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible();
  const nearMe = app.getByRole('radio', { name: 'Near me', exact: true });
  await nearMe.click();
  // Not "allow it for this site": nothing the visitor can allow would help here.
  await expect(app.getByText('Location isn’t available on this page. Pick your area instead.')).toBeVisible();
  await expect(app.getByText(/blocking location/)).toHaveCount(0);
  await expect(nearMe).not.toBeChecked();
  await expect(app.getByRole('img', { name: / away$/ })).toHaveCount(0);
  await snap(page, 'demo-29-near-me-framed');

  await app.getByRole('tab', { name: /Account/ }).click();
  await button(app, 'See the barber side').click();
  await app.getByRole('tab', { name: /My shop/ }).click();
  const location = app.getByRole('group', { name: 'Shop location' });
  await location.getByRole('button', { name: 'Remove the shop location' }).click();
  await button(location, 'Use my location here').click();
  await expect(
    location.getByText('Location isn’t available on this page. Customers can still find you by your address.'),
  ).toBeVisible();
  await expect(location.getByText('Location set')).toHaveCount(0);
});

/**
 * Slows the demo's server down, or cuts it off, the way a weak signal does
 * (see DEMO_NETWORK_KEY in src/demo/server.ts); null puts it back.
 */
const network = (page: Page, value: { delayMs?: number; offline?: boolean; log?: boolean } | null) =>
  page.evaluate(
    (value) =>
      value
        ? localStorage.setItem('potongku.demo.network', JSON.stringify(value))
        : localStorage.removeItem('potongku.demo.network'),
    value,
  );

test('My bookings opens with what it showed last time, and keeps it when a refresh fails', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await app.getByRole('tab', { name: /My bookings/ }).click();
  const booking = app.getByText(/^Skin fade with (Ali|Danial) · RM25$/);
  await expect(booking).toBeVisible();

  // On a slow line, opening the app again shows his booking at once, with a
  // small spinner by the title while the server answers.
  await network(page, { delayMs: 4000 });
  await page.reload();
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(booking).toBeVisible();
  const refreshing = app.getByRole('progressbar', { name: 'Refreshing' });
  await expect(refreshing).toBeVisible();
  // Cancelling waits for the server's list, so it never acts on an old one.
  const cancel = button(app, /^Cancel booking on /);
  await expect(cancel).toBeDisabled();
  await snap(page, 'demo-30-bookings-refreshing');
  await expect(refreshing).toHaveCount(0, { timeout: 20_000 });
  await expect(cancel).toBeEnabled();
  await expect(booking).toBeVisible();

  // With no connection, what he saw stays, with when it is from and a way to try again.
  await network(page, { offline: true });
  await page.reload();
  const stale = app
    .getByRole('status')
    .filter({ hasText: /Couldn’t refresh\. Showing what you saw (yesterday )?at \d{1,2}:\d{2}\s?(am|pm)\./i });
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await expect(stale).toBeVisible();
  await app.getByRole('tab', { name: /My bookings/ }).click();
  await expect(booking).toBeVisible();
  await expect(stale).toBeVisible();
  await expect(button(app, 'Add to calendar')).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await snap(page, 'demo-31-bookings-offline');

  // Back online, Try again brings the server's list, and the buttons work again.
  await network(page, null);
  await stale.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(stale).toHaveCount(0);
  await expect(booking).toBeVisible();
  await expect(cancel).toBeEnabled();
  await expect(button(app, 'Add to calendar')).toBeEnabled();
});

test('on a slow line the barbers’ cards show their shape first, and a shop opens with what the list knew', async ({
  page,
}) => {
  const app = await open(page);
  await network(page, { delayMs: 2500 });
  await button(app, 'Try as a customer').click();
  await expect(app.getByRole('progressbar', { name: 'Loading barbers' })).toBeVisible({ timeout: 15_000 });
  await snap(page, 'demo-32-barbers-loading');
  await expect(listed(app, 'Kemas Barber Kajang')).toBeVisible({ timeout: 20_000 });
  await expect(app.getByRole('progressbar', { name: 'Loading barbers' })).toHaveCount(0);

  // Its name, rating and address come straight from the list, while its services load.
  await listed(app, 'Kemas Barber Kajang').click();
  const services = app.getByRole('progressbar', { name: 'Loading services' });
  await expect(services).toBeVisible();
  // The stars come from the list; "See reviews" waits until there are reviews on the page to go to.
  await expect(app.getByRole('img', { name: /^Rated \d\.\d out of 5 from \d+ reviews$/ })).toBeVisible();
  await expect(app.getByRole('link', { name: /See reviews$/ })).toHaveCount(0);
  await snap(page, 'demo-33-shop-opening');
  await network(page, null);
  await expect(app.getByRole('radio', { name: /^Haircut RM/ })).toBeVisible({ timeout: 15_000 });
  await expect(services).toHaveCount(0);
  await expect(app.getByRole('link', { name: /^Rated \d\.\d out of 5 from \d+ reviews\. See reviews$/ })).toBeVisible();
});

/** How many times the app has asked the demo's server for `path` since `network(page, { log: true })`. */
const asked = (page: Page, path: string) =>
  page.evaluate(
    (path) => (JSON.parse(localStorage.getItem('potongku.demo.requests') ?? '[]') as string[]).filter((p) => p === path).length,
    path,
  );

test('Find a barber asks for its list once on a new day, with last night’s showing meanwhile', async ({ page }) => {
  const app = await open(page);
  await button(app, 'Try as a customer').click();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await expect(app.getByRole('progressbar', { name: 'Refreshing' })).toHaveCount(0);

  // The list kept on the phone, as if seen last night.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('potongku.cache.') && k.includes('.find|'))!;
    const kept = JSON.parse(localStorage.getItem(key)!);
    const yesterday = new Date(Date.now() - 86_400_000);
    kept.data.listedOn = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
    localStorage.setItem(key, JSON.stringify(kept));
  });
  await network(page, { log: true });
  await page.reload();
  await expect(listed(app, 'Ali Barber Sungai Chua')).toBeVisible();
  await expect.poll(() => asked(page, '/rest/v1/rpc/find_shops')).toBe(1);
  await expect(app.getByRole('progressbar', { name: 'Refreshing' })).toHaveCount(0);
  // A second ask would have gone out alongside the first.
  await page.waitForTimeout(500);
  expect(await asked(page, '/rest/v1/rpc/find_shops')).toBe(1);
  expect(await asked(page, '/rest/v1/rpc/my_shops')).toBe(1);
});

test.describe('on an iPhone', () => {
  // Chromium, telling the app it is Safari on an iPhone.
  test.use({ userAgent: devices['iPhone 13'].userAgent });

  test('Add to calendar saves a calendar file, which Safari hands to Apple Calendar', async ({ page }) => {
    // The page on its own, not in a frame: a frame may not be allowed to download, so there it opens Google Calendar.
    await page.goto('/artifact/demo-page/index.html');
    await expect(page.getByText('Try it with sample shops in Kajang')).toBeVisible();
    await button(page, 'Try as a customer').click();
    await expect(listed(page, 'Ali Barber Sungai Chua')).toBeVisible();
    await page.getByRole('tab', { name: /My bookings/ }).click();
    await expect(page.getByText(/^Skin fade with (Ali|Danial) · RM25$/)).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), button(page, 'Add to calendar').click()]);
    expect(download.suggestedFilename()).toBe('skin-fade-at-ali-barber-sungai-chua.ics');
    const ics = fs.readFileSync(await download.path(), 'utf8');
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/\r\nEND:VCALENDAR\r\n$/);
    expect(ics).toContain('\r\nSUMMARY:Skin fade at Ali Barber Sungai Chua\r\n');
    expect(ics).toMatch(/\r\nDTSTART:\d{8}T\d{6}Z\r\nDTEND:\d{8}T\d{6}Z\r\n/);
    expect(ics).toContain('\r\nTRIGGER:-PT1H\r\n');
  });
});
