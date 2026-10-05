import { expect, test, type Page } from '@playwright/test';

// One story, start to finish: a barber sets up a shop and goes live, a
// customer finds it and books, a second customer can't take the same slot,
// and the barber sees and handles the booking.

const run = Date.now().toString(36);
const barber = { name: 'Ali Rahman', phone: '012-345 6789', email: `ali-${run}@test.my`, password: 'password123' };
const customer = { name: 'Ben Lim', phone: '013-222 3333', email: `ben-${run}@test.my`, password: 'password123' };
const customer2 = { name: 'Chong Wei', phone: '014-555 6666', email: `chong-${run}@test.my`, password: 'password123' };
const shopName = `Kemas Barber ${run}`;

/** Saves a screenshot when SCREENSHOTS=<dir> is set (handy for reviewing UI). */
async function snap(page: Page, name: string) {
  const dir = process.env.SCREENSHOTS;
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function signUp(page: Page, who: typeof barber) {
  await field(page, 'Full name').fill(who.name);
  await field(page, 'Phone (WhatsApp)').fill(who.phone);
  await field(page, 'Email').fill(who.email);
  await field(page, 'Password').fill(who.password);
  await button(page, 'Create account').click();
}

async function signIn(page: Page, who: typeof barber) {
  await page.goto('/sign-in');
  await field(page, 'Email').fill(who.email);
  await field(page, 'Password').fill(who.password);
  await button(page, 'Sign in').click();
}

async function signOut(page: Page) {
  await page.evaluate(() => window.localStorage.clear());
}

/** On a shop page: picks Haircut and tomorrow, returns the first free time. */
async function pickHaircutTomorrow(page: Page) {
  await page.getByText('Haircut', { exact: true }).click();
  await button(page, /^Tomorrow/).click();
  const firstTime = page.getByRole('button', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
  await expect(firstTime).toBeVisible();
  return firstTime;
}

test.describe.serial('booking flow', () => {
  let bookedTime = '';

  // Cancelling asks first; say yes.
  test.beforeEach(({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
  });

  test('barber signs up, sets up the shop and goes live', async ({ page }) => {
    await page.goto('/');
    await snap(page, '01-welcome');
    await button(page, 'Set up my shop').click();
    await expect(page.getByText('Your first month is free.', { exact: false })).toBeVisible();
    await snap(page, '02-sign-up-barber');
    await signUp(page, barber);

    await expect(page.getByText('Set up your shop')).toBeVisible();
    await snap(page, '03-shop-setup');
    await field(page, 'Shop name').fill(shopName);
    await field(page, 'Address').fill('No. 12, Jalan Reko, Kajang');
    await button(page, 'Create my shop').click();

    // Onboarding checklist on the bookings tab.
    await expect(page.getByText('Get ready for bookings')).toBeVisible();
    await snap(page, '04-barber-bookings-empty');

    // Services: quick add a haircut.
    await page.getByRole('tab', { name: /Services/ }).click();
    await button(page, '+ Haircut RM20').click();
    await expect(page.getByText('Your menu')).toBeVisible();
    await expect(page.getByText('30 min', { exact: true })).toBeVisible();
    await snap(page, '05-services');

    // Barbers: the owner got the first chair; open Sundays too.
    await page.getByRole('tab', { name: /Barbers/ }).click();
    await expect(page.getByText(barber.name, { exact: true })).toBeVisible();
    await expect(page.getByText('Mon–Sat · 10:00–20:00')).toBeVisible();
    await snap(page, '06-barbers');
    await button(page, 'Hours').click();
    await expect(field(page, 'Barber name')).toBeVisible();
    await snap(page, '07-hours');
    await button(page, 'Open').last().click(); // Sunday is listed last
    await button(page, '+ Add break (e.g. Friday prayers)').click();
    await field(page, 'Break from').fill('13:00');
    await field(page, 'Break to').fill('14:30');
    await button(page, 'Save hours').click();
    await expect(page.getByText('Every day · 10:00–20:00')).toBeVisible();

    // Go live.
    await page.getByRole('tab', { name: /My shop/ }).click();
    await expect(page.getByText('Not live yet')).toBeVisible();
    await expect(page.getByText(/Free trial: 30 days left/)).toBeVisible();
    await button(page, 'Go live').click();
    await expect(page.getByText('You are live')).toBeVisible();
    await snap(page, '08-my-shop');
    await signOut(page);
  });

  test('customer finds the shop and books', async ({ page }) => {
    await page.goto('/');
    await button(page, 'Find a barber').click();
    await snap(page, '09-explore');
    await page.getByText(shopName).click();
    await expect(page.getByText('1. Pick a service')).toBeVisible();

    const time = await pickHaircutTomorrow(page);
    bookedTime = (await time.textContent()) ?? '';
    await time.click();
    await snap(page, '10-shop-page');
    await button(page, 'Sign in to book').click();

    // Not signed in yet: sign up and land back on the shop with the slot still picked.
    await button(page, 'Create an account').click();
    await signUp(page, customer);
    await expect(button(page, 'Confirm booking')).toBeVisible();
    await field(page, 'Note for your barber (optional)').fill('Low fade please');
    await button(page, 'Confirm booking').click();

    await expect(page.getByText("You're booked!")).toBeVisible();
    await snap(page, '11-booked');
    await button(page, 'See my bookings').click();
    await expect(page.getByText('Upcoming')).toBeVisible();
    await expect(page.getByText(`Haircut with ${barber.name} · RM20`)).toBeVisible();
    await snap(page, '12-my-bookings');
    await signOut(page);
  });

  test('another customer cannot take the same slot', async ({ page }) => {
    await page.goto('/sign-up');
    await signUp(page, customer2);
    await expect(page.getByText('Find a barber')).toBeVisible();
    await page.getByText(shopName).click();
    await pickHaircutTomorrow(page);
    await expect(page.getByRole('button', { name: bookedTime, exact: true })).toHaveCount(0);
    await signOut(page);
  });

  test('barber sees the booking and cancels it', async ({ page }) => {
    await signIn(page, barber);
    await expect(page.getByText('Bookings').first()).toBeVisible();
    await button(page, /^Tomorrow/).click();
    await expect(page.getByText(customer.name, { exact: true })).toBeVisible();
    await expect(page.getByText('“Low fade please”')).toBeVisible();
    await snap(page, '13-barber-day');
    await button(page, 'Cancel').click();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await signOut(page);
  });

  test('barber blocks lunch and adds a WhatsApp booking', async ({ page }) => {
    await signIn(page, barber);
    await button(page, /^Tomorrow/).click();

    await button(page, '+ Add booking or block time').click();
    await button(page, 'Block time').first().click();
    await button(page, /^1 hr$/).click();
    await field(page, 'Start time').fill('12:00');
    await field(page, 'Reason (optional)').fill('Lunch');
    await button(page, 'Block time').last().click();
    await expect(page.getByText(`Lunch · ${barber.name}`)).toBeVisible();

    await button(page, '+ Add booking or block time').click();
    await button(page, /^Haircut/).click();
    await field(page, 'Start time').fill('15:00');
    await field(page, 'Customer name').fill('Pak Abu');
    await field(page, 'Customer phone (optional)').fill('019-111 2222');
    await snap(page, '14-add-booking');
    await button(page, 'Add booking').click();
    await expect(page.getByText('Pak Abu (added by you)')).toBeVisible();
    await snap(page, '15-barber-day-with-guest');
    await signOut(page);
  });

  test('online customers cannot book blocked or taken times', async ({ page }) => {
    await signIn(page, customer2);
    await page.getByText(shopName).click();
    await pickHaircutTomorrow(page);
    await expect(page.getByRole('button', { name: '11:00 am', exact: true })).toBeVisible();
    for (const taken of ['12:00 pm', '12:30 pm', '3:00 pm']) {
      await expect(page.getByRole('button', { name: taken, exact: true })).toHaveCount(0);
    }
    await signOut(page);
  });

  test('customer sees the cancellation', async ({ page }) => {
    await signIn(page, customer);
    await page.getByRole('tab', { name: /My bookings/ }).click();
    await expect(page.getByText('Past')).toBeVisible();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByText('Upcoming')).toHaveCount(0);
  });
});
