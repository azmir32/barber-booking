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
/** A chip that is one choice of several, like a day, a time or a service. */
const choice = (page: Page, name: string | RegExp) => page.getByRole('radio', { name, exact: typeof name === 'string' });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/** Opens a time picker by its label and picks a time such as "2:30 pm". */
async function pickClock(page: Page, label: string, time: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click();
  await page.getByRole('dialog', { name: label }).getByRole('radio', { name: time, exact: true }).click();
  await expect(page.getByRole('dialog', { name: label })).toHaveCount(0);
}

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

/** Matches the day-picker chip `offset` days from today in Kuala Lumpur, e.g. "Wed 7 Oct". */
function dayChip(offset: number) {
  const day = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  const part = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', ...opts }).format(day);
  return new RegExp(`^${part({ weekday: 'short' })}\\s?${part({ day: 'numeric' })} ${part({ month: 'short' })}`);
}

/** Says yes in the app's "Are you sure?" dialog. */
async function confirm(page: Page, label: string) {
  await page.getByRole('alertdialog').getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
}

async function signOut(page: Page) {
  await page.evaluate(() => window.localStorage.clear());
}

/** On a shop page: picks Haircut and tomorrow, returns the first free time. */
async function pickHaircutTomorrow(page: Page) {
  await choice(page, /^Haircut/).click();
  await choice(page, /^Tomorrow/).click();
  const firstTime = page.getByRole('radio', { name: /^\d{1,2}:\d{2}\s?(am|pm)$/i }).first();
  await expect(firstTime).toBeVisible();
  return firstTime;
}

test.describe.serial('booking flow', () => {
  let bookedTime = '';

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
    await expect(page.getByText('Mon–Sat · 10:00 am–8:00 pm')).toBeVisible();
    await snap(page, '06-barbers');
    await button(page, 'Hours').click();
    await expect(field(page, 'Barber name')).toBeVisible();
    await snap(page, '07-hours');
    await page.getByRole('group', { name: 'Sun' }).getByRole('radio', { name: 'Open' }).click();
    await button(page, '+ Add break (e.g. Friday prayers)').click();
    await pickClock(page, 'Break to', '2:30 pm');
    await button(page, 'Save hours').click();
    await expect(page.getByText('Every day · 10:00 am–8:00 pm · Fri break 1:00 pm–2:30 pm')).toBeVisible();

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
    await field(page, 'Note for your barber (optional)').fill('Low fade please');
    await snap(page, '10-shop-page');
    await button(page, 'Continue to book').click();

    // Not signed in yet: the account is made for this booking, then it books straight away.
    await expect(page.getByText('Your booking')).toBeVisible();
    await expect(page.getByText(new RegExp(`^Haircut · .*, ${bookedTime}$`))).toBeVisible();
    await signUp(page, customer);

    await expect(page.getByText('You’re booked!')).toBeVisible();
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
    await expect(choice(page, bookedTime)).toHaveCount(0);
    await signOut(page);
  });

  test('barber sees the booking and cancels it', async ({ page }) => {
    await signIn(page, barber);
    await expect(page.getByText('Bookings').first()).toBeVisible();
    await choice(page, /^Tomorrow/).click();
    await expect(page.getByText(customer.name, { exact: true })).toBeVisible();
    await expect(page.getByText('“Low fade please”')).toBeVisible();
    await snap(page, '13-barber-day');
    await button(page, `More actions for ${customer.name}`).click();
    await button(page, 'Cancel booking').click();
    await expect(page.getByText('Cancel this booking?')).toBeVisible();
    await snap(page, '13b-confirm-cancel');
    await confirm(page, 'Cancel and WhatsApp');
    // The browser can't open WhatsApp without another tap, so the app offers one.
    await expect(page.getByText(`Booking cancelled. Let ${customer.name} know.`)).toBeVisible();
    await expect(button(page, `WhatsApp ${customer.name}`).first()).toBeVisible();
    await expect(page.getByText('Cancelled (1)')).toBeVisible();
    await signOut(page);
  });

  test('barber blocks lunch and adds a WhatsApp booking', async ({ page }) => {
    await signIn(page, barber);
    await choice(page, /^Tomorrow/).click();

    await button(page, '+ Add booking or block time').click();
    await choice(page, 'Block time').click();
    await choice(page, /^1 hr$/).click();
    await pickClock(page, 'Start time', '12:00 pm');
    await field(page, 'Reason (optional)').fill('Lunch');
    await button(page, 'Block time').click();
    await expect(page.getByText(`Lunch · ${barber.name}`)).toBeVisible();

    await button(page, '+ Add booking or block time').click();
    await choice(page, /^Haircut/).click();
    // Lunch is blocked, so the free times skip 12:00 pm.
    await choice(page, /^Afternoon/).click();
    await expect(choice(page, '12:00 pm')).toHaveCount(0);
    await choice(page, '3:00 pm').click();
    await field(page, 'Customer name (optional)').fill('Pak Abu');
    await field(page, 'Customer phone (optional)').fill('019-111 2222');
    await snap(page, '14-add-booking');
    await button(page, 'Add booking').click();
    await expect(page.getByText('Pak Abu (added by you)')).toBeVisible();
    await snap(page, '15-barber-day-with-guest');

    await choice(page, dayChip(2)).click();
    await button(page, '+ Add booking or block time').click();
    await choice(page, 'Block time').click();
    await choice(page, 'Whole day').click();
    await expect(page.getByRole('button', { name: /^Start time:/ })).toHaveCount(0);
    await field(page, 'Reason (optional)').fill('Day off');
    await button(page, 'Block the day').click();
    await expect(page.getByText('Whole day', { exact: true })).toBeVisible();
    await expect(page.getByText(`Day off · ${barber.name}`)).toBeVisible();
    await signOut(page);
  });

  test('online customers cannot book blocked or taken times', async ({ page }) => {
    await signIn(page, customer2);
    await page.getByText(shopName).click();
    await pickHaircutTomorrow(page);
    await expect(choice(page, '11:00 am')).toBeVisible();
    await choice(page, /^Afternoon/).click();
    await expect(choice(page, '2:00 pm')).toBeVisible();
    for (const taken of ['12:00 pm', '12:30 pm', '3:00 pm']) {
      await expect(choice(page, taken)).toHaveCount(0);
    }
    await choice(page, dayChip(2)).click();
    await expect(page.getByText(/^No free times this day/)).toBeVisible();
    await signOut(page);
  });

  test('customer sees the cancellation', async ({ page }) => {
    await signIn(page, customer);
    await page.getByRole('tab', { name: /My bookings/ }).click();
    await expect(page.getByText('Earlier')).toBeVisible();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByText('Upcoming')).toHaveCount(0);
  });

  test('customer who forgot their password resets it with an emailed code', async ({ page, request }) => {
    await page.goto('/sign-in');
    await field(page, 'Email').fill(customer2.email);
    await button(page, 'Forgot password?').click();
    await expect(field(page, 'Email')).toHaveValue(customer2.email);
    await button(page, 'Send code').click();
    await expect(field(page, 'Code from the email')).toBeVisible();

    await field(page, 'Code from the email').fill('000000');
    await field(page, 'New password').fill('new-password-456');
    await button(page, 'Set new password').click();
    await expect(page.getByText('That code is wrong or has expired', { exact: false })).toBeVisible();

    const { code } = await (await request.get(`/__test/recovery-code?email=${encodeURIComponent(customer2.email)}`)).json();
    await field(page, 'Code from the email').fill(code);
    await snap(page, '16-reset-password');
    await button(page, 'Set new password').click();
    await expect(page.getByText('Find a barber')).toBeVisible();
    await signOut(page);

    await signIn(page, { ...customer2, password: 'new-password-456' });
    await expect(page.getByText('Find a barber')).toBeVisible();
  });

  test('customer deletes their account', async ({ page }) => {
    await signIn(page, { ...customer2, password: 'new-password-456' });
    await page.getByRole('tab', { name: /Account/ }).click();
    await button(page, 'Delete account').click();
    await confirm(page, 'Delete account');
    await expect(page.getByText('Are you a barber?')).toBeVisible();

    await signIn(page, { ...customer2, password: 'new-password-456' });
    await expect(page.getByText('Invalid login credentials')).toBeVisible();
  });
});
