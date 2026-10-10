import { devices, expect, test, type FrameLocator, type Page } from '@playwright/test';
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

const button = (app: FrameLocator | Page, name: string | RegExp) =>
  app.getByRole('button', { name, exact: typeof name === 'string' });

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

  await button(app, 'Cancel').first().click();
  await expect(app.getByRole('alertdialog')).toBeVisible();
  await expect(app.getByRole('alertdialog').getByText(/Added it to your calendar\? Delete it there too\.$/)).toBeVisible();
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

  // Hakim moves his cut an hour later on his own phone; this screen hasn't reloaded yet.
  await page.evaluate(() => {
    const key = 'potongku.demo.v1';
    const saved = JSON.parse(localStorage.getItem(key)!);
    type Row = Record<string, string | null>;
    const hakim = (saved.tables.profiles as Row[]).find((p) => p.full_name === 'Hakim')!;
    const cut = (saved.tables.bookings as Row[]).find(
      (b) => b.customer_id === hakim.id && b.status === 'confirmed' && Date.parse(b.starts_at!) > Date.now(),
    )!;
    const later = (at: string | null) => new Date(Date.parse(at!) + 3_600_000).toISOString();
    Object.assign(cut, { starts_at: later(cut.starts_at), ends_at: later(cut.ends_at), reminded_at: null });
    localStorage.setItem(key, JSON.stringify(saved));
  });

  const opened = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  expect(await sent(opened)).toMatch(/is tomorrow at 4:30 pm\./);
  // The row now shows the new time, says the reminder wasn't saved, and still offers one.
  const notSaved = app.getByRole('alert');
  await expect(notSaved).toHaveText('Reminder not saved. This booking has changed. Check the new time.');
  await expect(app.getByText('5:30 pm', { exact: true })).toBeVisible();
  await snap(page, 'demo-11-reminder-not-saved');

  const again = context.waitForEvent('page');
  await button(app, 'Remind Hakim on WhatsApp').click();
  expect(await sent(again)).toMatch(/is tomorrow at 5:30 pm\./);
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
  // Paused, not new: bookings already made still stand.
  await expect(app.getByText('Bookings paused')).toBeVisible();
  await expect(button(app, 'Turn bookings back on')).toBeVisible();
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

test.describe('on an iPhone', () => {
  // Chromium, telling the app it is Safari on an iPhone.
  test.use({ userAgent: devices['iPhone 13'].userAgent });

  test('Add to calendar saves a calendar file, which Safari hands to Apple Calendar', async ({ page }) => {
    // The page on its own, not in a frame: a frame may not be allowed to download, so there it opens Google Calendar.
    await page.goto('/artifact/demo-page/index.html');
    await expect(page.getByText('Try it with sample shops in Kajang')).toBeVisible();
    await button(page, 'Try as a customer').click();
    await expect(page.getByText('Ali Barber Sungai Chua')).toBeVisible();
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
