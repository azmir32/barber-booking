# PotongKu

A booking app for barbers. Barbers sign up, list their services, chairs and hours, and share a booking link. Customers find a barber, pick a service, barber and time, and book without calling or DMing. Launching in Kajang first.

One app serves both sides: people choose "Customer" or "Barber / shop owner" when they sign up.

## What's in phase 1

**Everyone**
- Email and password sign-in, with password reset by emailed code
- Delete account from the Account screen (required by the App Store and Google Play)
- English or Bahasa Melayu: follows the phone's language, with a switch on the welcome screen and under Account
- Opens at once on a slow line: Find a barber, My bookings, the barber's Bookings tab and My shop's Takings, Customers and Reviews show what they showed last time straight away (kept on the phone for a day, for that account only, and forgotten on sign out or account deletion), with a small spinner by the title while the server's answer comes. If that fails the old answer stays, with "Couldn't refresh. Showing what you saw at 3:05 pm." and Try again; buttons that change a booking wait for the fresh list. A first visit shows grey shapes of what is coming, and a shop opened from the list shows its name, stars and address while the rest loads. In the demo, with every request taking 1.5 seconds, opening the app again shows the barbers in 0.2 seconds instead of 3.5, and My bookings in 0.1 seconds instead of 1.9

**Customers**
- Browse live barbershops, see which are open now and when each can next take you, and search by name or area
- Near me: the first chip on Find a barber asks for the phone's location (only while the app is open, never in the background) and lists shops nearest first, each with how far it is ("800 m", "1.2 km", "12 km"); shops that haven't set their location come after, by name. It is that or an area, not both; a search still filters, and what it finds stays nearest first. It is remembered for next time and asks for a fresh position then, while the customer's next cut and barbers show at once. If location is refused or can't be found, one line says so and how to allow it, and the list stays as it was; on a web page that can't have location at all (the demo framed by another site without `allow="geolocation"`), it says that instead and to pick an area. The shop's page shows the distance by its address
- Coming back is one tap: Find a barber starts with their next cut and up to three of their barbers, each with the last cut there, when it is next free and Book again with the same service and barber already picked (or that it isn't taking bookings). The one they went to last says "Due for a cut" once their usual gap there has passed with nothing booked
- Book a service with a chosen barber or "any barber", from free 15-minute slots over the next 14 days, with an optional note for the barber
- Pick a time first and sign up after; the chosen slot is kept
- See upcoming and past bookings, move one to another time, cancel, WhatsApp the shop, book again
- Rate a cut from one to five stars, with an optional comment, once the shop has marked it done: My bookings asks "How was your cut?" for 14 days after it, and the rating can be changed in that time. The form says which name the review will show (the name they go by, worked out from their full name: "Mohd Hakim bin Ali" is Hakim, "Tan Wei Jie" is Wei Jie, never a surname) and lets them change it. The shop's reply shows under it
- A shop with three or more reviews shows its average and count (4.8 ★ (23)) in the list and by its name; its page lists the reviews below the booking steps, newest first, each with the customer's chosen name, the barber, the comment and the shop's reply
- Add a booking to the phone's calendar, so it reminds them: Safari on iPhone, iPad and Mac gets a calendar file for Apple Calendar (with an alert an hour before); Android, the iOS app and other browsers open Google Calendar's add-event page (with their usual Google reminder)

**Barbers and shop owners**
- Create a shop with a booking link (`/shop/your-shop`); a link another shop already has is flagged at the field, with a free one to try (e.g. with the area added). Someone who picked "Barber / shop owner" by mistake can carry on as a customer from the set-up screen, or sign out
- Shop location, optional, on the new-shop form and in My shop's details: "Use my location here", tapped while in the shop, sets it from the phone, but only from a precise fix (within 50 m, never the phone's last known position, and not with location allowed as approximate only), as every customer's Directions go there; otherwise it says to turn on Precise location or try again near the door. Then "Check on the map" opens Google Maps at that point, and Remove clears it. With it set, Near me can list the shop, and Directions (on the shop's page, after booking and in My bookings) go to that point instead of searching for the address
- Services menu with prices and durations, plus quick-add suggestions
- Barbers (one per chair) with weekly working hours and an optional daily break (e.g. Friday prayers); a solo barber is a shop with one chair
- Bookings by day with expected takings, refreshed every minute and by pulling down; mark done or no-show once the time has started, move a booking to another free time when the customer calls (it stays theirs, and a WhatsApp tells them the new time), cancel, WhatsApp the customer
- The day as chairs: a List/Chairs switch on the Bookings tab, remembered on the phone, puts each barber working that day in a column (team order, names staying on top) against a time column from the earliest opening to the latest closing. Bookings are blocks as long as the cut, with name, service and time, coloured by to come, now, done or no-show; breaks, blocked time and closed hours are shaded and labelled, a barber's whole day blocked is named above the chairs and opens its block, and today has a now line (opening there when Chairs was last time's choice). Tapping a booking gives the same actions as in the list; tapping free time opens Add to the day with that barber and quarter hour picked. Two chairs fit on a small phone and more scroll sideways; a wide window fits them all
- What customers changed since you last looked: the Bookings tab shows how many bookings customers made, moved or cancelled (checked every minute and when the app comes back), and a card at the top lists them, e.g. "Wei Jie cancelled today at 5:30 pm with Ali, so that chair is free". Each line opens its day; new bookings say New until Got it, which each phone remembers by the newest change it was sent
- WhatsApp reminders the day before: one tap opens WhatsApp with the message written, and every phone in the shop sees who has been reminded (moving a booking clears it; one that never went out can be taken back). Today's view says how many of tomorrow's customers are still to remind. Customers who booked today, or are coming later today, can still be reminded from More
- Customer list from My shop: everyone who has booked or been in, online or added by the shop (walk-ins are matched by phone number however it was typed, including to an online customer with that number), with their number, visits, last cut and next booking. Customers due for a cut (their usual gap between cuts has passed and nothing is booked) come first, with a ready-written WhatsApp invite that includes the booking link, which is also there for anyone away much longer; anyone with a number can be messaged or called. Searchable by name or number
- Add walk-in, WhatsApp or phone bookings, and block time or a whole day off (or close the whole shop for the day), so online customers can't take those times
- Takings for this week, last week or this month: money in and cuts done against the same point in the period before (once the shop has been on the app that long), no-shows and cancellations, the busiest days (by the average day) and hours, each barber's share and the top services. My shop shows the week so far in one line
- Reviews from My shop: the average, how many and the newest comment, then every review with the cut it was for. The owner can reply to each (shown under it on the shop's page), and change or remove the reply
- Go live / pause, share or copy the booking link; while paused, the link asks customers to WhatsApp the shop, and My shop says the shop is paused (bookings already made still stand) rather than new
- Close the whole shop for a few days (Hari Raya): days with customers still to come say how many, and those booked on the chosen days are listed to cancel and WhatsApp one by one before it closes
- One-month free trial on every new shop. From five days before it ends, My shop (and the poster once it has ended) has a button that WhatsApps the PotongKu team, with the shop's name and link written, to subscribe

**Rules enforced in the database**
- A barber can never be double-booked (Postgres exclusion constraint)
- Bookings are only created through `book_appointment` (customers) and `add_shop_booking` (owners), and moved through `reschedule_booking` (the customer, or the shop's owner), which re-check the slot is free and inside working hours
- Customers only see their own bookings; owners only see their own shop's bookings and customers
- Takings come from one owner-only `shop_summary` call over at most 93 days, counted at the price each booking was made at
- What customers changed comes from one owner-only `shop_changes` call: only what customers did themselves (the booking functions note it; the shop's own changes never count), for bookings from today on, at most a week back
- Shops are only visible while published and paid up or inside the free trial
- A shop's location is both latitude and longitude or neither, and on the map; only its owner sets it. Distances are worked out inside `find_shops` (great-circle, with `km_between`, which nobody can call on its own). The customer's position is never stored or logged: the app rounds it to about 100 m, keeps it in memory only, and sends it in the request's body, never in the URL that access logs keep. Don't turn on logging of every statement with its values (`log_statement = 'all'`, or `log_min_duration_statement` low enough to catch `find_shops`), as that would log it
- Owners can't change their own trial or subscription status, or when their shop first went live (`shops.published_at`, set by the database)
- A barber account can turn into a customer one (`become_customer`) only while it has no shop
- Limits against abuse: bookings at most 60 days ahead, at most 4 upcoming bookings per customer per shop, notes, review comments and replies up to 280 characters
- Only the customer can rate a cut, one rating per booking, once it is marked done and up to 14 days after it started (`rate_booking`); owners can't rate their own shop. Nobody can read which account wrote a review, only the name it shows. Owners only reply (`reply_to_review`), and the database keeps each shop's review count and total
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

To see it on a weak signal, run `localStorage.setItem('potongku.demo.network', '{"delayMs":1500}')` (or `'{"offline":true}'`) in the browser console and reload; remove the key to put it back.

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
npm test            # date, money, phone, reminder, distance and language helpers, and the demo backend
npm run test:db     # schema + booking rules against a throwaway local Postgres 16+
npm run test:e2e    # the whole app in a browser: barber sets up, customers book
npm run test:demo   # the one-file demo, in a locked-down iframe with no network
npm run test:load   # Malaysia-sized data, the busiest screens under load and a booking rush
```

`test:db` needs `initdb`, `pg_ctl` and `psql` installed locally (it does not need Supabase or Docker).

`test:e2e` builds the web app and runs it against a local stand-in for Supabase (Postgres, [PostgREST](https://github.com/PostgREST/postgrest/releases) 12 and a small auth gateway in `e2e/backend`). It needs Postgres 16+, the PostgREST binary on your `PATH` (or `POSTGREST=/path/to/postgrest`) and Playwright's Chromium (`npx playwright install chromium`). Set `SCREENSHOTS=<folder>` to save a screenshot of each step there, and `COLOR_SCHEME=dark` to run in dark mode.

GitHub Actions runs all of these on every push (`.github/workflows/ci.yml`) except `test:load`, which takes a few minutes and needs the same Postgres and PostgREST as `test:e2e`.

## How many users it handles

`npm run test:load` fills a local Postgres with 1,000 live shops (three chairs each), 100,000 customers, about 2.9 million bookings (90 days of history and the next 30 days) and 280,000 reviews, sends each screen's own requests 50 at a time for 15 seconds, then has 300 customers try to book the same shop's Saturday evening at once. On a 4-core machine that also runs the load generator:

| Screen | Requests a second | Typical (p50) | Slow (p95) |
| --- | --- | --- | --- |
| Find a barber, signed in (open now, next free time, your next cut and your barbers) | 178 | 244 ms | 619 ms |
| Barbers near me (the same list, nearest first) | 182 | 238 ms | 625 ms |
| Search for a barber | 352 | 105 ms | 382 ms |
| Shop page (with closed days, today's hours and the newest reviews) | 281 | 176 ms | 220 ms |
| Free times for a day | 1,271 | 38 ms | 52 ms |
| Book a cut (free times, then book) | 608 | 82 ms | 127 ms |
| My bookings (with ratings) | 647 | 69 ms | 155 ms |
| Barber's day (with what customers changed) | 278 | 175 ms | 252 ms |

In the rush, six customers got the last evening times and the other 294 were told the time was just taken, all within half a second and with no errors.

Find a barber is the slowest screen because it works out each listed shop's next free time, and for a signed-in customer also their own barbers' (about 4 ms of database time on top of the list's 12 ms). Even so, one such machine serves it over 600,000 times an hour.

Near me measures the distance to every live shop with a location and keeps the nearest page, with no index. On the 1,000 load-test shops that adds about 1 ms of database time to the list (median of 50 calls from random points around Kajang: 14.9 ms nearest first against 14.0 ms by name; picking the nearest 21 alone takes about 1.3 ms). In `npm run test:load` the "Barbers near me" screen keeps up with Find a barber by name. That is fine for thousands of shops. Past tens of thousands, give the shops a spatial index and search by box or nearest-neighbour instead: Postgres's `earthdistance` extension (a GiST index on `ll_to_earth(latitude, longitude)` and `earth_box` around the customer), or PostGIS (a `geography` column with a GiST index and `ORDER BY location <-> point`). Either needs only `find_shops` changed, not the app.

That is far more than a pre-Raya peak needs: if all 100,000 customers booked within the same hour, it would be under 30 bookings a second. What it changes is the bill, not the code:

- The data above takes about 1.5 GB, and grows by roughly 4.5 GB a year at that size. Supabase's free plan stops at 500 MB, so a Malaysia-wide launch needs a paid plan; a Kajang launch with a few dozen shops stays under it for its first few years.
- Supabase's built-in email only sends a few messages an hour, so password reset needs your own email provider (custom SMTP) before launch, whatever the size.
- More than 50,000 monthly active sign-ins also needs a paid plan.

## Running the business side by hand (until payments are built)

- A shop's free trial ends 30 days after it is created (`shops.trial_ends_at`).
- When a barber pays, set `subscription_status = 'active'` on their shop in the Supabase table editor.
- When a trial ends without payment, the shop disappears from search and its link stops taking bookings (it tells customers to WhatsApp the shop instead).
- Barbers ask to subscribe from the app's "Keep my shop live" button, which WhatsApps the number in `EXPO_PUBLIC_SUPPORT_WHATSAPP` (set it in `.env` before launch; without it, WhatsApp opens with the message written and asks who to send it to). An EAS build with the `production` profile stops early if this number or the Supabase settings are missing (`scripts/check-release.mjs`).

## Translations

Screens wrap their text in `t('English text')`; the Malay for each line is in [`src/lib/strings-ms.ts`](src/lib/strings-ms.ts), keyed by the English. `npm test` fails if any text is missing a Malay line, so add one whenever you add or change a sentence.

## Renaming the app

The name shown in the app comes from `name` in `app.json`. Also update `slug`, `scheme`, `ios.bundleIdentifier` and `android.package` there before the first store release. The icon, splash and favicon are drawn by `node scripts/make-icons.mjs` (a scissors on the brand red); change `BRAND` there and re-run it.

## Next phases

- Automatic push reminders the day before, to cut no-shows (for now, barbers send WhatsApp reminders from the app)
- Online subscription payments for barbers (FPX and cards)
- Optional deposits at booking
- A photo gallery of cuts
- Reporting unfair reviews
- A map of the barbers near you (Near me lists them nearest first already)
- Walk-in queue mode
