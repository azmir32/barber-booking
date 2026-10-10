# PotongKu

A booking app for barbers. Barbers sign up, list their services, chairs and hours, and share a booking link. Customers find a barber, pick a service, barber and time, and book without calling or DMing. Launching in Kajang first.

One app serves both sides: people choose "Customer" or "Barber / shop owner" when they sign up.

## What's in phase 1

**Everyone**
- Email and password sign-in, with password reset by emailed code
- Delete account from the Account screen (required by the App Store and Google Play)
- English or Bahasa Melayu: follows the phone's language, with a switch on the welcome screen and under Account

**Customers**
- Browse live barbershops, see which are open now and when each can next take you, and search by name or area
- Book a service with a chosen barber or "any barber", from free 15-minute slots over the next 14 days, with an optional note for the barber
- Pick a time first and sign up after; the chosen slot is kept
- See upcoming and past bookings, move one to another time, cancel, WhatsApp the shop, book again
- Add a booking to the phone's calendar, so it reminds them: Safari on iPhone, iPad and Mac gets a calendar file for Apple Calendar (with an alert an hour before); Android, the iOS app and other browsers open Google Calendar's add-event page (with their usual Google reminder)

**Barbers and shop owners**
- Create a shop with a booking link (`/shop/your-shop`); a link another shop already has is flagged at the field, with a free one to try (e.g. with the area added). Someone who picked "Barber / shop owner" by mistake can carry on as a customer from the set-up screen, or sign out
- Services menu with prices and durations, plus quick-add suggestions
- Barbers (one per chair) with weekly working hours and an optional daily break (e.g. Friday prayers); a solo barber is a shop with one chair
- Bookings by day with expected takings, refreshed every minute and by pulling down; mark done or no-show once the time has started, move a booking to another free time when the customer calls (it stays theirs, and a WhatsApp tells them the new time), cancel, WhatsApp the customer
- WhatsApp reminders the day before: one tap opens WhatsApp with the message written, and every phone in the shop sees who has been reminded (moving a booking clears it; one that never went out can be taken back). Today's view says how many of tomorrow's customers are still to remind. Customers who booked today, or are coming later today, can still be reminded from More
- Customer list from My shop: everyone who has booked or been in, online or added by the shop (walk-ins are matched by phone number however it was typed, including to an online customer with that number), with their number, visits, last cut and next booking. Customers due for a cut (their usual gap between cuts has passed and nothing is booked) come first, with a ready-written WhatsApp invite that includes the booking link, which is also there for anyone away much longer; anyone with a number can be messaged or called. Searchable by name or number
- Add walk-in, WhatsApp or phone bookings, and block time or a whole day off (or close the whole shop for the day), so online customers can't take those times
- Takings for this week, last week or this month: money in and cuts done against the same point in the period before (once the shop has been on the app that long), no-shows and cancellations, the busiest days (by the average day) and hours, each barber's share and the top services. My shop shows the week so far in one line
- Go live / pause, share or copy the booking link; while paused, the link asks customers to WhatsApp the shop, and My shop says the shop is paused (bookings already made still stand) rather than new
- Close the whole shop for a few days (Hari Raya): days with customers still to come say how many, and those booked on the chosen days are listed to cancel and WhatsApp one by one before it closes
- One-month free trial on every new shop. From five days before it ends, My shop (and the poster once it has ended) has a button that WhatsApps the PotongKu team, with the shop's name and link written, to subscribe

**Rules enforced in the database**
- A barber can never be double-booked (Postgres exclusion constraint)
- Bookings are only created through `book_appointment` (customers) and `add_shop_booking` (owners), and moved through `reschedule_booking` (the customer, or the shop's owner), which re-check the slot is free and inside working hours
- Customers only see their own bookings; owners only see their own shop's bookings and customers
- Takings come from one owner-only `shop_summary` call over at most 93 days, counted at the price each booking was made at
- Shops are only visible while published and paid up or inside the free trial
- Owners can't change their own trial or subscription status, or when their shop first went live (`shops.published_at`, set by the database)
- A barber account can turn into a customer one (`become_customer`) only while it has no shop
- Limits against abuse: bookings at most 60 days ahead, at most 4 upcoming bookings per customer per shop, notes up to 280 characters
- Barbers with booking history can't be deleted (mark them away instead), so past bookings keep their barber; one added by mistake can be removed

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
npm test            # date, money, phone, reminder and language helpers, and the demo backend
npm run test:db     # schema + booking rules against a throwaway local Postgres 16+
npm run test:e2e    # the whole app in a browser: barber sets up, customers book
npm run test:demo   # the one-file demo, in a locked-down iframe with no network
npm run test:load   # Malaysia-sized data, the busiest screens under load and a booking rush
```

`test:db` needs `initdb`, `pg_ctl` and `psql` installed locally (it does not need Supabase or Docker).

`test:e2e` builds the web app and runs it against a local stand-in for Supabase (Postgres, [PostgREST](https://github.com/PostgREST/postgrest/releases) 12 and a small auth gateway in `e2e/backend`). It needs Postgres 16+, the PostgREST binary on your `PATH` (or `POSTGREST=/path/to/postgrest`) and Playwright's Chromium (`npx playwright install chromium`). Set `SCREENSHOTS=<folder>` to save a screenshot of each step there, and `COLOR_SCHEME=dark` to run in dark mode.

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`) except `test:load`, which takes a few minutes and needs the same Postgres and PostgREST as `test:e2e`.

## How many users it handles

`npm run test:load` fills a local Postgres with 1,000 live shops (three chairs each), 100,000 customers and about 2.7 million bookings (90 days of history and the next 30 days), sends each screen's own requests 50 at a time for 15 seconds, then has 300 customers try to book the same shop's Saturday evening at once. On a 4-core machine that also runs the load generator:

| Screen | Requests a second | Typical (p50) | Slow (p95) |
| --- | --- | --- | --- |
| Find a barber (with open now and next free time) | 225 | 185 ms | 519 ms |
| Search for a barber | 272 | 137 ms | 488 ms |
| Shop page (with closed days and today's hours) | 240 | 180 ms | 403 ms |
| Free times for a day | 1,145 | 42 ms | 59 ms |
| Book a cut (free times, then book) | 558 | 92 ms | 127 ms |
| My bookings | 997 | 49 ms | 72 ms |
| Barber's day | 324 | 152 ms | 200 ms |

In the rush, four customers got the last evening times and the other 296 were told the time was just taken, all within half a second and with no errors.

That is far more than a pre-Raya peak needs: if all 100,000 customers booked within the same hour, it would be under 30 bookings a second. What it changes is the bill, not the code:

- The data above takes about 1.2 GB, and grows by roughly 3.5 GB a year at that size. Supabase's free plan stops at 500 MB, so a Malaysia-wide launch needs a paid plan; a Kajang launch with a few dozen shops stays under it for its first few years.
- Supabase's built-in email only sends a few messages an hour, so password reset needs your own email provider (custom SMTP) before launch, whatever the size.
- More than 50,000 monthly active sign-ins also needs a paid plan.

## Running the business side by hand (until payments are built)

- A shop's free trial ends 30 days after it is created (`shops.trial_ends_at`).
- When a barber pays, set `subscription_status = 'active'` on their shop in the Supabase table editor.
- When a trial ends without payment, the shop disappears from search and its link stops taking bookings (it tells customers to WhatsApp the shop instead).
- Barbers ask to subscribe from the app's "Keep my shop live" button, which WhatsApps the number in `EXPO_PUBLIC_SUPPORT_WHATSAPP` (set it in `.env` before launch; without it, WhatsApp opens with the message written and asks who to send it to).

## Translations

Screens wrap their text in `t('English text')`; the Malay for each line is in [`src/lib/strings-ms.ts`](src/lib/strings-ms.ts), keyed by the English. `npm test` fails if any text is missing a Malay line, so add one whenever you add or change a sentence.

## Renaming the app

The name shown in the app comes from `name` in `app.json`. Also update `slug`, `scheme`, `ios.bundleIdentifier` and `android.package` there before the first store release. The icon, splash and favicon are drawn by `node scripts/make-icons.mjs` (a scissors on the brand red); change `BRAND` there and re-run it.

## Next phases

- Automatic push reminders the day before, to cut no-shows (for now, barbers send WhatsApp reminders from the app)
- Online subscription payments for barbers (FPX and cards)
- Optional deposits at booking
- Reviews and a photo gallery of cuts
- "Find a barber near me" with a map
- Walk-in queue mode
