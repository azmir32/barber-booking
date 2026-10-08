# PotongKu

A booking app for barbers. Barbers sign up, list their services, chairs and hours, and share a booking link. Customers find a barber, pick a service, barber and time, and book without calling or DMing. Launching in Kajang first.

One app serves both sides: people choose "Customer" or "Barber / shop owner" when they sign up.

## What's in phase 1

**Everyone**
- Email and password sign-in, with password reset by emailed code
- Delete account from the Account screen (required by the App Store and Google Play)
- English or Bahasa Melayu: follows the phone's language, with a switch on the welcome screen and under Account

**Customers**
- Browse live barbershops, see which are open now, and search by name or area
- Book a service with a chosen barber or "any barber", from free 15-minute slots over the next 14 days, with an optional note for the barber
- Pick a time first and sign up after; the chosen slot is kept
- See upcoming and past bookings, move one to another time, cancel, WhatsApp the shop, book again

**Barbers and shop owners**
- Create a shop with a booking link (`/shop/your-shop`)
- Services menu with prices and durations, plus quick-add suggestions
- Barbers (one per chair) with weekly working hours and an optional daily break (e.g. Friday prayers); a solo barber is a shop with one chair
- Bookings by day with expected takings, refreshed every minute and by pulling down; mark done or no-show once the time has started, cancel, WhatsApp the customer
- Add walk-in, WhatsApp or phone bookings, and block time or a whole day off, so online customers can't take those times
- Go live / pause, share or copy the booking link; while paused, the link asks customers to WhatsApp the shop
- One-month free trial on every new shop

**Rules enforced in the database**
- A barber can never be double-booked (Postgres exclusion constraint)
- Bookings are only created through `book_appointment` (customers) and `add_shop_booking` (owners), and moved through `reschedule_booking`, which re-check the slot is free and inside working hours
- Customers only see their own bookings; owners only see their own shop's bookings and customers
- Shops are only visible while published and paid up or inside the free trial
- Owners can't change their own trial or subscription status
- Limits against abuse: bookings at most 60 days ahead, at most 4 upcoming bookings per customer per shop, notes up to 280 characters
- Barbers with booking history can't be deleted (mark them away instead), so past bookings keep their barber

## Tech

- [Expo](https://expo.dev) SDK 57 with Expo Router (iOS, Android and web from one codebase)
- [Supabase](https://supabase.com) for sign-in, Postgres and row-level security
- Schema and functions: [`supabase/migrations`](supabase/migrations)

## Trying it without Supabase

```bash
npm run build:demo
```

This builds `dist-demo/index.html`: the whole web app in one file, with a pretend backend inside the page ([`src/demo`](src/demo)) and four sample shops around Kajang. Open it in any browser, or host it anywhere, and tap **Try as a customer** (Hakim) or **Try as a barber** (Ali of Ali Barber Sungai Chua). Nothing is sent anywhere; changes are kept in that browser until **Start the demo again**. The demo password reset code is `123456`.

The pretend backend copies the database rules in `supabase/migrations` (row-level security, the booking functions and their messages), so when you change a rule there, change it in `src/demo` too. `npm test` checks the demo backend through the real Supabase client.

## Getting it running

1. Create a free project at [supabase.com](https://supabase.com).
2. Apply the database schema, either:
   - paste `supabase/migrations/20261005000000_init.sql` into the Supabase SQL editor and run it, or
   - with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
3. Copy `.env.example` to `.env` and fill in the project URL and anon key (Supabase: Project Settings > API).
4. Install and start:

   ```bash
   npm install
   npx expo start
   ```

   Scan the QR code with the Expo Go app on your phone, or press `w` for the web version.

Tip for testing: in Supabase under Authentication > Sign In / Providers > Email, you can turn off "Confirm email" so new accounts can sign in straight away.

### Emails (password reset)

"Forgot password?" emails a 6-digit code instead of a link, so it works the same in the app and on the web. Two settings in Supabase under Authentication > Emails:

1. In the **Reset password** template, add the code, for example: `<p>Your PotongKu code is <strong>{{ .Token }}</strong></p>`.
2. Before launch, set up **SMTP settings** with an email provider (Resend, Brevo, etc.). Supabase's built-in sender only delivers to your own team's addresses and a few emails an hour.

## Checks

```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm test            # date, money, phone and language helpers, and the demo backend
npm run test:db     # schema + booking rules against a throwaway local Postgres 16+
npm run test:e2e    # the whole app in a browser: barber sets up, customers book
npm run test:demo   # the one-file demo, in a locked-down iframe with no network
npm run test:load   # Malaysia-sized data, the busiest screens under load and a booking rush
```

`test:db` needs `initdb`, `pg_ctl` and `psql` installed locally (it does not need Supabase or Docker).

`test:e2e` builds the web app and runs it against a local stand-in for Supabase (Postgres, [PostgREST](https://github.com/PostgREST/postgrest/releases) 12 and a small auth gateway in `e2e/backend`). It needs Postgres 16+, the PostgREST binary on your `PATH` (or `POSTGREST=/path/to/postgrest`) and Playwright's Chromium (`npx playwright install chromium`). Set `SCREENSHOTS=<folder>` to save a screenshot of each step there, and `COLOR_SCHEME=dark` to run in dark mode.

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`) except `test:load`, which takes a few minutes and needs the same Postgres and PostgREST as `test:e2e`.

## How many users it handles

`npm run test:load` fills a local Postgres with 1,000 live shops (three chairs each), 100,000 customers and 2.85 million bookings (90 days of history and the next 30 days), sends each screen's own requests 50 at a time for 15 seconds, then has 300 customers try to book the same shop's Saturday evening at once. On a 4-core machine that also runs the load generator:

| Screen | Requests a second | Typical (p50) | Slow (p95) |
| --- | --- | --- | --- |
| Find a barber | 476 | 91 ms | 236 ms |
| Shop page | 597 | 82 ms | 112 ms |
| Free times for a day | 376 | 110 ms | 311 ms |
| Book a cut (free times, then book) | 190 | 236 ms | 579 ms |
| My bookings | 983 | 47 ms | 93 ms |
| Barber's day | 322 | 148 ms | 214 ms |

In the rush, the six free evening times went to six customers and the other 294 were told the time was just taken, all within 2.3 seconds and with no errors.

That is far more than a pre-Raya peak needs: if all 100,000 customers booked within the same hour, it would be under 30 bookings a second. What it changes is the bill, not the code:

- The data above takes about 1.1 GB, and grows by roughly 3.5 GB a year at that size. Supabase's free plan stops at 500 MB, so a Malaysia-wide launch needs a paid plan; a Kajang launch with a few dozen shops stays under it for its first few years.
- Supabase's built-in email only sends a few messages an hour, so password reset needs your own email provider (custom SMTP) before launch, whatever the size.
- More than 50,000 monthly active sign-ins also needs a paid plan.

## Running the business side by hand (until payments are built)

- A shop's free trial ends 30 days after it is created (`shops.trial_ends_at`).
- When a barber pays, set `subscription_status = 'active'` on their shop in the Supabase table editor.
- When a trial ends without payment, the shop disappears from search and its link stops taking bookings (it tells customers to WhatsApp the shop instead).

## Translations

Screens wrap their text in `t('English text')`; the Malay for each line is in [`src/lib/strings-ms.ts`](src/lib/strings-ms.ts), keyed by the English. `npm test` fails if any text is missing a Malay line, so add one whenever you add or change a sentence.

## Renaming the app

The name shown in the app comes from `name` in `app.json`. Also update `slug`, `scheme`, `ios.bundleIdentifier` and `android.package` there before the first store release. The icon, splash and favicon are drawn by `node scripts/make-icons.mjs` (a scissors on the brand red); change `BRAND` there and re-run it.

## Next phases

- WhatsApp / push reminders the day before, to cut no-shows
- Online subscription payments for barbers (FPX and cards)
- Optional deposits at booking
- Reviews and a photo gallery of cuts
- Shop-wide holidays (e.g. closing every chair for Hari Raya in one step)
- "Find a barber near me" with a map
- Walk-in queue mode
