import { expect, test, type Page } from '@playwright/test';

// The app speaks English or Bahasa Melayu: it follows the phone's language,
// and anyone can switch on the welcome screen or under Account.

const run = Date.now().toString(36);

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const choice = (page: Page, name: string | RegExp) => page.getByRole('radio', { name, exact: typeof name === 'string' });
const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function snap(page: Page, name: string) {
  const dir = process.env.SCREENSHOTS;
  if (!dir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

test.describe('on a phone set to Malay', () => {
  test.use({ locale: 'ms-MY' });

  test('starts in Malay and remembers a switch to English', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Anda seorang barber?')).toBeVisible();
    await snap(page, 'ms-01-welcome');

    await button(page, 'Switch to English').click();
    await expect(page.getByText('Are you a barber?')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Are you a barber?')).toBeVisible();

    await button(page, 'Tukar ke Bahasa Melayu').click();
    await expect(page.getByText('Anda seorang barber?')).toBeVisible();
  });

  test('a barber signs up and sets up shop in Malay', async ({ page }) => {
    await page.goto('/');
    await button(page, 'Sediakan kedai saya').click();
    await field(page, 'Nama penuh').fill('Hafiz');
    await field(page, 'Telefon (WhatsApp)').fill('012-999 8888');
    await field(page, 'E-mel').fill(`hafiz-${run}@test.my`);
    await field(page, 'Kata laluan').fill('password123');
    await snap(page, 'ms-02-sign-up');
    await button(page, 'Daftar akaun').click();

    await expect(page.getByText('Sediakan kedai anda')).toBeVisible();
    await field(page, 'Nama kedai').fill(`Gunting Hafiz ${run}`);
    await button(page, 'Cipta kedai saya').click();
    await expect(page.getByText('Bersedia untuk menerima tempahan')).toBeVisible();
    await expect(choice(page, /^Hari ini/)).toBeVisible();
    await snap(page, 'ms-03-bookings');

    await page.getByRole('tab', { name: /Servis/ }).click();
    await button(page, /^\+ Potong rambut RM20$/).click();
    await expect(page.getByText('Potong rambut', { exact: true })).toBeVisible();
    await expect(page.getByText('30 min', { exact: true })).toBeVisible();
    await snap(page, 'ms-04-services');

    await page.getByRole('tab', { name: /Barber/ }).click();
    await expect(page.getByText('Isn–Sab · 10.00 pagi–8.00 malam')).toBeVisible();
    await button(page, 'Waktu kerja').click();
    await expect(button(page, '+ Tambah rehat (cth. solat Jumaat)')).toBeVisible();
    // Times read the Malay way, and the picker groups them by pagi, tengah hari, petang and malam.
    await expect(button(page, 'Dari: 10.00 pagi')).toHaveCount(6);
    await button(page, 'Hingga: 8.00 malam').first().click();
    const picker = page.getByRole('dialog', { name: 'Hingga' });
    for (const part of ['Pagi', 'Tengah hari', 'Petang', 'Malam']) {
      await expect(picker.getByText(part, { exact: true })).toBeVisible();
    }
    await expect(picker.getByRole('radio', { name: '1.30 tengah hari', exact: true })).toBeVisible();
    await expect(picker.getByRole('radio', { name: '8.00 malam', exact: true })).toBeChecked();
    await picker.getByRole('button', { name: 'Batal', exact: true }).click();
    await snap(page, 'ms-05-hours');
    await button(page, 'Batal').click();

    await page.getByRole('tab', { name: /Kedai saya/ }).click();
    await expect(page.getByText('Percubaan percuma: tinggal 30 hari')).toBeVisible();
    await button(page, 'Buka tempahan').click();
    await expect(page.getByText('Tempahan dibuka')).toBeVisible();
    await snap(page, 'ms-06-my-shop');

    await page.getByRole('tab', { name: 'Tempahan' }).click();
    await button(page, '+ Tambah tempahan atau sekat masa').click();
    await choice(page, 'Sekat masa').click();
    await choice(page, 'Seharian').click();
    await button(page, 'Sekat sepanjang hari').click();
    await expect(page.getByText('Seharian', { exact: true })).toBeVisible();
    await snap(page, 'ms-07-day-blocked');
  });
});

test('an English phone can switch to Malay from Account', async ({ page }) => {
  await page.goto('/customer');
  await page.getByRole('tab', { name: /Account/ }).click();
  await page.getByText('Bahasa Melayu', { exact: true }).click();
  await expect(page.getByRole('tab', { name: /Tempahan saya/ })).toBeVisible();
  await expect(page.getByText('Anda sedang melayari sebagai tetamu.')).toBeVisible();
  await page.getByRole('tab', { name: /Barber/ }).click();
  await expect(page.getByText('Cari barber', { exact: true })).toBeVisible();
});
