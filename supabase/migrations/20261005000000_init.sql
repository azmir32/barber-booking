-- Barber booking: core schema for phase 1.
-- Shops own barbers (chairs), services and working hours. Customers book a
-- service with a barber at a time slot. All times are stored as timestamptz;
-- each shop has a time zone (Kajang launch: Asia/Kuala_Lumpur).

create extension if not exists btree_gist;

create type public.user_role as enum ('customer', 'barber');
create type public.booking_status as enum ('confirmed', 'cancelled', 'completed', 'no_show');

-- Profiles ------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'customer',
  full_name text not null default '' check (length(full_name) <= 80),
  phone text check (length(phone) <= 20),
  created_at timestamptz not null default now()
);

-- Create a profile whenever someone signs up. The app passes role, full_name
-- and phone in the sign-up metadata.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, full_name, phone)
  values (
    new.id,
    case when new.raw_user_meta_data ->> 'role' = 'barber' then 'barber'::public.user_role
         else 'customer'::public.user_role end,
    left(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 80),
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), 20), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Shops ---------------------------------------------------------------------

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 40),
  about text check (length(about) <= 500),
  address text check (length(address) <= 200),
  area text not null default 'Kajang' check (length(area) between 1 and 60),
  phone text check (length(phone) <= 20),
  instagram text check (length(instagram) <= 60),
  time_zone text not null default 'Asia/Kuala_Lumpur',
  is_published boolean not null default false,
  -- Billing: every shop starts with a one-month free trial. Until payments are
  -- built, an admin sets subscription_status = 'active' by hand.
  trial_ends_at timestamptz not null default now() + interval '30 days',
  subscription_status text not null default 'trialing'
    check (subscription_status in ('trialing', 'active', 'past_due', 'cancelled')),
  created_at timestamptz not null default now()
);

-- A shop is live (visible and bookable) when the owner published it and it is
-- paid up or still inside the free trial.
create function public.shop_is_live(s public.shops)
returns boolean
language sql
stable
as $$
  select s.is_published
     and (s.subscription_status = 'active'
          or (s.subscription_status = 'trialing' and s.trial_ends_at > now()));
$$;

create function public.owns_shop(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from shops where id = p_shop_id and owner_id = auth.uid());
$$;

-- The signed-in barber's shop (an owner has at most one), or null. Policies
-- call it as (select public.my_shop_id()) so Postgres works it out once per
-- query instead of once per row, and can use the shop_id indexes.
create function public.my_shop_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from shops where owner_id = auth.uid();
$$;

-- Barbers (one per chair) ---------------------------------------------------

create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index barbers_shop_id_idx on public.barbers (shop_id);

-- Services ------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  duration_min int not null check (duration_min between 5 and 480),
  price numeric(10, 2) not null check (price between 0 and 10000),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index services_shop_id_idx on public.services (shop_id);

-- Working hours: one or more ranges per barber per weekday (0 = Sunday). -----

create table public.working_hours (
  id uuid primary key default gen_random_uuid(),
  barber_id uuid not null references public.barbers (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  check (closes_at > opens_at),
  -- Ranges for the same barber and day may not overlap.
  constraint working_hours_no_overlap exclude using gist (
    barber_id with =,
    weekday with =,
    tsrange(date '2000-01-01' + opens_at, date '2000-01-01' + closes_at) with &&
  )
);

-- Bookings ------------------------------------------------------------------

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- Barbers with booking history can't be deleted, only marked away.
  barber_id uuid not null references public.barbers (id),
  service_id uuid references public.services (id) on delete set null,
  -- Online bookings have a customer account. Bookings the shop adds itself
  -- (walk-ins, WhatsApp, phone calls) carry a guest name instead, and
  -- blocked time (breaks, errands) has neither.
  customer_id uuid references public.profiles (id) on delete cascade,
  guest_name text check (length(guest_name) <= 80),
  guest_phone text check (length(guest_phone) <= 20),
  is_block boolean not null default false,
  -- Snapshot of the service at booking time, so later price edits don't
  -- rewrite history. For blocked time this is the reason.
  service_name text not null check (length(service_name) <= 80),
  price numeric(10, 2) not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.booking_status not null default 'confirmed',
  customer_note text check (length(customer_note) <= 280),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (is_block or customer_id is not null or guest_name is not null),
  -- A barber can never be double-booked.
  constraint bookings_no_overlap exclude using gist (
    barber_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);
create index bookings_shop_starts_idx on public.bookings (shop_id, starts_at);
-- shop_id is in here for the per-shop booking limit and so a shop owner's
-- check on each customer's name stays one index lookup however long the
-- shop's history grows.
create index bookings_customer_idx on public.bookings (customer_id, shop_id, starts_at);

-- Row level security --------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.shops enable row level security;
alter table public.barbers enable row level security;
alter table public.services enable row level security;
alter table public.working_hours enable row level security;
alter table public.bookings enable row level security;

-- Policies wrap auth.uid() and my_shop_id() in (select ...) so they run once
-- per query. Checked per row, a query over every booking took over a minute
-- with a Malaysia-sized table (e2e/load).
create policy "read own profile" on public.profiles
  for select using (id = (select auth.uid()));
create policy "shop owners read their customers" on public.profiles
  for select using (
    exists (
      select 1 from public.bookings b
      where b.customer_id = profiles.id and b.shop_id = (select public.my_shop_id())
    )
  );
create policy "update own profile" on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "read live or own shops" on public.shops
  for select using (public.shop_is_live(shops) or owner_id = (select auth.uid()));
create policy "barbers create their shop" on public.shops
  for insert with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'barber')
  );
create policy "owners update their shop" on public.shops
  for update using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- Barbers, services and hours are visible when their shop is: the shops and
-- barbers policies decide that inside these subqueries.
create policy "read barbers of visible shops" on public.barbers
  for select using (exists (select 1 from public.shops s where s.id = shop_id));
create policy "owners manage barbers" on public.barbers
  for all using (shop_id = (select public.my_shop_id()))
  with check (shop_id = (select public.my_shop_id()));

create policy "read services of visible shops" on public.services
  for select using (exists (select 1 from public.shops s where s.id = shop_id));
create policy "owners manage services" on public.services
  for all using (shop_id = (select public.my_shop_id()))
  with check (shop_id = (select public.my_shop_id()));

create policy "read hours of visible shops" on public.working_hours
  for select using (exists (select 1 from public.barbers b where b.id = barber_id));
create policy "owners manage hours" on public.working_hours
  for all using (
    exists (select 1 from public.barbers b where b.id = barber_id and b.shop_id = (select public.my_shop_id()))
  ) with check (
    exists (select 1 from public.barbers b where b.id = barber_id and b.shop_id = (select public.my_shop_id()))
  );

-- Bookings are read directly but only written through the functions below.
create policy "customers and shop owners read bookings" on public.bookings
  for select using (customer_id = (select auth.uid()) or shop_id = (select public.my_shop_id()));

-- Users can't change their own role or billing fields from the app.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
revoke insert, update on public.shops from anon, authenticated;
grant insert (owner_id, name, slug, about, address, area, phone, instagram, is_published)
  on public.shops to authenticated;
grant update (name, slug, about, address, area, phone, instagram, is_published)
  on public.shops to authenticated;
revoke insert, update, delete on public.bookings from anon, authenticated;

-- Finding a barber ----------------------------------------------------------

-- The customer's shop list: live shops whose name, area or address contains
-- the search, a page at a time, with each shop's lowest price and number of
-- chairs. Sending every shop with all its services and barbers came to
-- 570 KB for 1,000 shops (e2e/load).
create function public.find_shops(
  p_search text default null,
  p_area text default null,
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  id uuid,
  name text,
  slug text,
  area text,
  address text,
  about text,
  from_price numeric,
  barber_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.slug, s.area, s.address, s.about,
         (select min(v.price) from services v where v.shop_id = s.id and v.is_active),
         (select count(*)::int from barbers b where b.shop_id = s.id and b.is_active)
  from shops s
  where public.shop_is_live(s)
    and (coalesce(trim(p_area), '') = '' or lower(s.area) = lower(trim(p_area)))
    and (
      coalesce(trim(p_search), '') = ''
      or strpos(lower(s.name || ' ' || s.area || ' ' || coalesce(s.address, '')), lower(trim(p_search))) > 0
    )
  order by lower(s.name), s.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Areas that have live shops, most shops first, for the area filter. Areas
-- are typed by barbers, so spellings that differ only in case count as one.
create function public.shop_areas()
returns table (area text, shops int)
language sql
stable
security definer
set search_path = public
as $$
  select mode() within group (order by s.area), count(*)::int
  from shops s
  where public.shop_is_live(s)
  group by lower(s.area)
  order by count(*) desc, lower(s.area);
$$;

-- Booking rules ------------------------------------------------------------

-- How far ahead customers can book, and how many upcoming bookings one
-- customer may hold at one shop (stops a single account blocking a day).
create function public.booking_horizon_days() returns int language sql immutable as $$ select 60 $$;
create function public.max_upcoming_per_shop() returns int language sql immutable as $$ select 4 $$;

-- Changes to one shop's bookings happen one at a time. Two people taking
-- overlapping times at once otherwise deadlock on bookings_no_overlap, and
-- Postgres fails one of them after a second's wait, holding a connection all
-- the while. In a load test of 1,000 customers rushing one shop's Saturday,
-- 20 deadlocks backed up the connection pool until 957 of them got an error
-- instead of "that time was just taken"; with this lock, none did.
-- Held until the transaction ends.
create function public.lock_shop_diary(p_shop_id uuid)
returns void
language sql
as $$
  select pg_advisory_xact_lock(hashtextextended('shop-diary:' || p_shop_id, 0));
$$;
revoke execute on function public.lock_shop_diary(uuid) from public, anon, authenticated;

-- Free start times for a service on a given local day, per barber.
-- Slots start every 15 minutes inside each barber's working hours, skip
-- anything already booked, skip times that have passed, and stop at the
-- booking horizon. p_ignore_booking leaves one booking out of the taken
-- times, so a booking being moved doesn't block its own neighbouring slots.
create function public.available_slots(
  p_service_id uuid,
  p_day date,
  p_barber_id uuid default null,
  p_ignore_booking uuid default null
)
returns table (barber_id uuid, starts_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with ignored as (
    -- Only the caller's own booking, or one at their shop, so nobody can
    -- find out when someone else is booked.
    select bk.id from bookings bk
    where bk.id = p_ignore_booking
      and (bk.customer_id = auth.uid() or public.owns_shop(bk.shop_id))
  ),
  svc as (
    select s.id, s.shop_id, s.duration_min, sh.time_zone
    from services s
    join shops sh on sh.id = s.shop_id
    where s.id = p_service_id
      and s.is_active
      and (public.shop_is_live(sh) or sh.owner_id = auth.uid())
      and p_day <= (now() at time zone sh.time_zone)::date + public.booking_horizon_days()
  ),
  candidates as (
    select distinct
           b.id as barber_id,
           t at time zone svc.time_zone as starts_at,
           svc.duration_min
    from svc
    join barbers b on b.shop_id = svc.shop_id and b.is_active
    join working_hours wh on wh.barber_id = b.id
      and wh.weekday = extract(dow from p_day)::int
    cross join lateral generate_series(
      p_day + wh.opens_at,
      p_day + wh.closes_at - make_interval(mins => svc.duration_min),
      interval '15 minutes'
    ) as t
    where (p_barber_id is null or b.id = p_barber_id)
  )
  select c.barber_id, c.starts_at
  from candidates c
  where c.starts_at > now()
    and not exists (
      select 1 from bookings bk
      where bk.barber_id = c.barber_id
        and bk.status <> 'cancelled'
        and bk.id is distinct from (select id from ignored)
        and tstzrange(bk.starts_at, bk.ends_at)
            && tstzrange(c.starts_at, c.starts_at + make_interval(mins => c.duration_min))
    )
  order by c.starts_at, c.barber_id;
$$;

-- Book a slot. With no barber given, picks the free barber with the fewest
-- bookings that day so work is shared across chairs.
create function public.book_appointment(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_barber_id uuid default null,
  p_note text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_service services;
  v_tz text;
  v_day date;
  v_barber uuid;
  v_booking bookings;
begin
  if v_uid is null then
    raise exception 'Please sign in to book.' using errcode = '28000';
  end if;

  select s.* into v_service from services s where s.id = p_service_id;
  if not found then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;

  if length(p_note) > 280 then
    raise exception 'Please keep your note under 280 characters.' using errcode = '22001';
  end if;

  perform public.lock_shop_diary(v_service.shop_id);

  if (
    select count(*) from bookings
    where customer_id = v_uid
      and shop_id = v_service.shop_id
      and status = 'confirmed'
      and starts_at > now()
  ) >= public.max_upcoming_per_shop() then
    raise exception 'You already have % upcoming bookings here. Cancel one to book another.',
      public.max_upcoming_per_shop() using errcode = 'P0001';
  end if;

  select time_zone into v_tz from shops where id = v_service.shop_id;
  v_day := (p_starts_at at time zone v_tz)::date;

  select a.barber_id into v_barber
  from public.available_slots(p_service_id, v_day, p_barber_id) a
  where a.starts_at = p_starts_at
  order by (
    select count(*) from bookings bk
    where bk.barber_id = a.barber_id
      and bk.status <> 'cancelled'
      and tstzrange(bk.starts_at, bk.ends_at)
          && tstzrange(v_day::timestamp at time zone v_tz, (v_day + 1)::timestamp at time zone v_tz)
  ), a.barber_id
  limit 1;

  if v_barber is null then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end if;

  begin
    insert into bookings (
      shop_id, barber_id, service_id, customer_id, service_name, price,
      starts_at, ends_at, customer_note
    ) values (
      v_service.shop_id, v_barber, v_service.id, v_uid, v_service.name, v_service.price,
      p_starts_at, p_starts_at + make_interval(mins => v_service.duration_min),
      nullif(trim(p_note), '')
    )
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

  return v_booking;
end;
$$;

-- Change a booking's status. Customers may cancel their own upcoming
-- bookings. Shop owners may cancel, and once the appointment has started,
-- mark it done or a no-show (or undo that by confirming it again).
create function public.set_booking_status(
  p_booking_id uuid,
  p_status public.booking_status
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
begin
  select * into v_booking from bookings where id = p_booking_id;
  if not found then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if public.owns_shop(v_booking.shop_id) then
    if p_status in ('completed', 'no_show') and v_booking.starts_at > now() then
      raise exception 'You can mark this once the appointment has started.' using errcode = '42501';
    end if;
  elsif v_booking.customer_id = auth.uid() then
    if p_status <> 'cancelled' or v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
      raise exception 'You can only cancel an upcoming booking.' using errcode = '42501';
    end if;
  else
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  perform public.lock_shop_diary(v_booking.shop_id);
  begin
    update bookings set status = p_status where id = p_booking_id returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'That time has been booked by someone else since.' using errcode = 'P0001';
  end;
  return v_booking;
end;
$$;

-- Move a booking to another free time instead of cancelling and booking
-- again, so it keeps its place in the diary, its note and its price.
-- Customers move their own upcoming bookings; shop owners move any of their
-- shop's bookings except blocked time, including one whose time has started
-- (a customer running late). The new time follows the same rules as
-- booking, except that the booking's own time doesn't count as taken, so
-- moving 15 minutes later works. With no barber given it stays with the
-- same barber if they are free, else goes to whoever is least busy that day.
create function public.reschedule_booking(
  p_booking_id uuid,
  p_starts_at timestamptz,
  p_barber_id uuid default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bookings;
  v_service services;
  v_tz text;
  v_day date;
  v_barber uuid;
begin
  -- Lock before reading, so nobody cancels or moves it in between.
  perform public.lock_shop_diary(shop_id) from bookings where id = p_booking_id;
  select * into v_booking from bookings where id = p_booking_id;
  if not found or v_booking.is_block then
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  if public.owns_shop(v_booking.shop_id) then
    if v_booking.status <> 'confirmed' then
      raise exception 'You can only change an upcoming booking.' using errcode = '42501';
    end if;
  elsif v_booking.customer_id = auth.uid() then
    if v_booking.status <> 'confirmed' or v_booking.starts_at <= now() then
      raise exception 'You can only change an upcoming booking.' using errcode = '42501';
    end if;
  else
    raise exception 'Booking not found.' using errcode = 'P0002';
  end if;

  select * into v_service from services where id = v_booking.service_id and is_active;
  if not found then
    raise exception 'This service is no longer available.' using errcode = 'P0002';
  end if;

  select time_zone into v_tz from shops where id = v_booking.shop_id;
  v_day := (p_starts_at at time zone v_tz)::date;

  select a.barber_id into v_barber
  from public.available_slots(v_service.id, v_day, p_barber_id, v_booking.id) a
  where a.starts_at = p_starts_at
  order by
    a.barber_id = v_booking.barber_id desc,
    (
      select count(*) from bookings bk
      where bk.barber_id = a.barber_id
        and bk.status <> 'cancelled'
        and tstzrange(bk.starts_at, bk.ends_at)
            && tstzrange(v_day::timestamp at time zone v_tz, (v_day + 1)::timestamp at time zone v_tz)
    ),
    a.barber_id
  limit 1;

  if v_barber is null then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end if;

  begin
    update bookings set
      barber_id = v_barber,
      starts_at = p_starts_at,
      ends_at = p_starts_at + make_interval(mins => v_service.duration_min)
    where id = v_booking.id
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'Sorry, that time was just taken. Please pick another.' using errcode = 'P0001';
  end;

  return v_booking;
end;
$$;

-- Replace a barber's whole week in one go, so a failed save never leaves
-- them with no hours. p_hours: [{"weekday": 1, "opens_at": "10:00", "closes_at": "20:00"}, ...]
create function public.set_barber_hours(p_barber_id uuid, p_hours jsonb)
returns setof public.working_hours
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from barbers b where b.id = p_barber_id and public.owns_shop(b.shop_id)
  ) then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  delete from working_hours where barber_id = p_barber_id;
  begin
    insert into working_hours (barber_id, weekday, opens_at, closes_at)
    select p_barber_id, (h ->> 'weekday')::smallint, (h ->> 'opens_at')::time, (h ->> 'closes_at')::time
    from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) h;
  exception
    when exclusion_violation then
      raise exception 'Some of those hours overlap on the same day.' using errcode = 'P0001';
    when check_violation then
      raise exception 'Closing time must be after opening time.' using errcode = 'P0001';
  end;

  return query select * from working_hours where barber_id = p_barber_id order by weekday, opens_at;
end;
$$;

-- Shop owners add bookings that came in another way (walk-in, WhatsApp,
-- phone) or block time, so online customers can't take those slots.
-- Times are the shop's local day and clock time. Working hours are not
-- enforced here: the owner may squeeze someone in.
create function public.add_shop_booking(
  p_barber_id uuid,
  p_day date,
  p_time time,
  p_duration_min int default null,
  p_service_id uuid default null,
  p_guest_name text default null,
  p_guest_phone text default null,
  p_note text default null,
  p_is_block boolean default false
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop shops;
  v_service services;
  v_minutes int;
  v_starts timestamptz;
  v_booking bookings;
begin
  select s.* into v_shop
  from barbers b join shops s on s.id = b.shop_id
  where b.id = p_barber_id and s.owner_id = auth.uid();
  if not found then
    raise exception 'Barber not found.' using errcode = 'P0002';
  end if;

  if p_service_id is not null then
    select * into v_service from services where id = p_service_id and shop_id = v_shop.id;
    if not found then
      raise exception 'Service not found.' using errcode = 'P0002';
    end if;
  end if;

  v_minutes := coalesce(p_duration_min, v_service.duration_min);
  if v_minutes is null or v_minutes < 5 or v_minutes > (case when p_is_block then 1440 else 720 end) then
    raise exception 'Pick a service, or a length between 5 minutes and 12 hours (a whole day for blocks).'
      using errcode = '22023';
  end if;
  if not p_is_block and nullif(trim(p_guest_name), '') is null then
    raise exception 'Add the customer''s name.' using errcode = '22023';
  end if;

  v_starts := (p_day + p_time) at time zone v_shop.time_zone;

  perform public.lock_shop_diary(v_shop.id);
  begin
    insert into bookings (
      shop_id, barber_id, service_id, guest_name, guest_phone, is_block,
      service_name, price, starts_at, ends_at, customer_note
    ) values (
      v_shop.id, p_barber_id, v_service.id,
      case when p_is_block then null else nullif(trim(p_guest_name), '') end,
      case when p_is_block then null else nullif(trim(p_guest_phone), '') end,
      p_is_block,
      case when p_is_block then coalesce(left(nullif(trim(p_note), ''), 80), 'Blocked')
           else coalesce(v_service.name, 'Appointment') end,
      case when p_is_block then 0 else coalesce(v_service.price, 0) end,
      v_starts, v_starts + make_interval(mins => v_minutes),
      case when p_is_block then null else nullif(trim(p_note), '') end
    )
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'That barber already has a booking at that time.' using errcode = 'P0001';
  end;

  return v_booking;
end;
$$;

-- People can delete their own account (the app stores require it).
-- A customer's upcoming bookings are cancelled, and their past ones stay in
-- the shop's history without their name or phone. An owner's shop goes
-- with them, along with its barbers, services and bookings.
create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  update bookings set
    status = case when status = 'confirmed' and starts_at > now()
                  then 'cancelled'::booking_status else status end,
    customer_id = null,
    guest_name = 'Deleted account',
    guest_phone = null,
    customer_note = null
  where customer_id = auth.uid();

  delete from auth.users where id = auth.uid();
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
revoke execute on function public.add_shop_booking(uuid, date, time, int, uuid, text, text, text, boolean) from public, anon;
grant execute on function public.add_shop_booking(uuid, date, time, int, uuid, text, text, text, boolean) to authenticated;
revoke execute on function public.book_appointment(uuid, timestamptz, uuid, text) from public, anon;
revoke execute on function public.set_booking_status(uuid, public.booking_status) from public, anon;
revoke execute on function public.reschedule_booking(uuid, timestamptz, uuid) from public, anon;
revoke execute on function public.set_barber_hours(uuid, jsonb) from public, anon;
grant execute on function public.book_appointment(uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.set_booking_status(uuid, public.booking_status) to authenticated;
grant execute on function public.reschedule_booking(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.set_barber_hours(uuid, jsonb) to authenticated;
