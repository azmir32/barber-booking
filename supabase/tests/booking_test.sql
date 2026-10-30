-- Behaviour tests for the booking schema. Run with: npm run test:db
-- Each check raises an exception on failure; the script stops at the first one.
\set ON_ERROR_STOP 1
\set QUIET 1

-- People ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b1', 'owner@test', '{"role":"barber","full_name":"Ali","phone":"0123456789"}'),
  ('00000000-0000-0000-0000-0000000000c1', 'cust1@test', '{"role":"customer","full_name":"Ben"}'),
  ('00000000-0000-0000-0000-0000000000c2', 'cust2@test', '{"full_name":"Chong"}');

do $$ begin
  assert (select role from profiles where id = '00000000-0000-0000-0000-0000000000b1') = 'barber',
    'barber sign-up should create a barber profile';
  assert (select role from profiles where id = '00000000-0000-0000-0000-0000000000c2') = 'customer',
    'sign-up without a role should default to customer';
end $$;

-- The owner sets up a shop ----------------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;

insert into shops (owner_id, name, slug, phone)
values ('00000000-0000-0000-0000-0000000000b1', 'Ali Cuts', 'ali-cuts', '012-345 6789');

-- Billing fields can't be chosen at sign-up either.
do $$ begin
  insert into shops (owner_id, name, slug, subscription_status)
  values ('00000000-0000-0000-0000-0000000000b1', 'Free Forever', 'free-forever', 'active');
  raise exception 'owner should not be able to set billing fields on insert';
exception when insufficient_privilege then null;
end $$;

-- Nor when it first went live: the database notes that.
do $$ begin
  assert (select published_at is null from shops where slug = 'ali-cuts'), 'a new shop has never been live';
  update shops set published_at = now();
  raise exception 'owners should not set when their shop went live';
exception when insufficient_privilege then null;
end $$;

-- Give the shop a fixed id so the rest of the script can refer to it.
reset role;
update shops set id = '00000000-0000-0000-0000-00000000005a' where slug = 'ali-cuts';
set role authenticated;
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a', 'Ali'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005a', 'Danial');
insert into services (id, shop_id, name, duration_min, price)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000005a', 'Haircut', 30, 25);
-- Both barbers work 09:00-12:00 every day.
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select b, d, '09:00', '12:00'
from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[]) b,
     generate_series(0, 6) d;

do $$ begin
  update shops set subscription_status = 'active';
  raise exception 'owner should not be able to change billing fields';
exception when insufficient_privilege then null;
end $$;

-- A customer can't see an unpublished shop ----------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

do $$ begin
  assert (select count(*) from shops) = 0, 'unpublished shop should be hidden from customers';
  assert (select count(*) from services) = 0, 'unpublished shop services should be hidden';
  assert (select count(*) from find_shops()) = 0, 'unpublished shop should not be listed';
  assert (select count(*) from shop_areas()) = 0, 'unpublished shop should not add an area';
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1',
          (now() at time zone 'Asia/Kuala_Lumpur')::date + 1)) = 0,
    'unpublished shop should have no slots';
  -- Its link still says whose shop it is, so customers can message them.
  assert (select name = 'Ali Cuts' and phone = '012-345 6789' and not is_live
          from shop_public_status('ali-cuts')), 'a hidden shop''s link should say it is not live';
  assert (select count(*) from shop_public_status('no-such-shop')) = 0, 'an unknown link should find nothing';
end $$;

set role anon;
do $$ begin
  assert (select not is_live from shop_public_status('ali-cuts')), 'guests should be able to check a link';
end $$;
set role authenticated;

do $$ begin
  insert into shops (owner_id, name, slug) values ('00000000-0000-0000-0000-0000000000c1', 'Nope', 'nope');
  raise exception 'customers should not be able to create shops';
exception when insufficient_privilege then null;
end $$;

-- Publish, then customers can see and book ---------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
update shops set is_published = true;

-- Pausing and going live again keep when it first went live, so the app can
-- tell a paused shop from a new one.
do $$
declare
  first_live timestamptz;
begin
  select published_at into first_live from shops;
  assert first_live is not null, 'going live notes when';
  update shops set is_published = false;
  assert (select published_at = first_live from shops), 'pausing keeps when it first went live';
  update shops set is_published = true;
  assert (select published_at = first_live from shops), 'going live again keeps the first time';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  ten timestamptz := (d + time '10:00') at time zone 'Asia/Kuala_Lumpur';
  b bookings;
begin
  assert (select count(*) from shops) = 1, 'published shop should be visible';
  assert (select from_price = 25 and barber_count = 2 from find_shops()), 'listing should show price and chairs';
  assert (select opens_today = '09:00' and closes_today = '12:00' from find_shops()), 'listing should show today''s hours';
  assert (select is_live from shop_public_status('ali-cuts')), 'a live shop''s link should say so';
  assert (select count(*) from find_shops(' ALI ')) = 1, 'search should ignore case and spaces';
  assert (select count(*) from find_shops('kajang')) = 1, 'search should look at the area';
  assert (select count(*) from find_shops('%')) = 0, 'search text is not a pattern';
  assert (select count(*) from find_shops(null, 'KAJANG')) = 1, 'area filter should ignore case';
  assert (select count(*) from find_shops(null, 'Bangi')) = 0, 'area filter should filter';
  assert (select count(*) from find_shops(null, null, 20, 1)) = 0, 'offset should page';
  assert (select area = 'Kajang' and shops = 1 from shop_areas()), 'areas should count live shops';
  -- 09:00..11:30 every 15 min = 11 start times per barber.
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 11, 'expected 11 slots for one barber';
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d)) = 22,
    'expected 22 slots across both barbers';

  b := book_appointment('00000000-0000-0000-0000-0000000000e1', ten, '00000000-0000-0000-0000-0000000000a1', 'fade please');
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a1', 'should book the chosen barber';
  assert b.ends_at = ten + interval '30 minutes', 'booking should last the service duration';
  assert b.price = 25 and b.service_name = 'Haircut', 'booking should snapshot the service';

  -- 09:45, 10:00 and 10:15 now overlap Ali's 10:00-10:30 booking.
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 8, 'overlapping slots should disappear';

  -- "Any barber" at 10:00 goes to the free barber.
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', ten);
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a2', 'any-barber booking should pick the free barber';

  -- Now nobody is free at 10:00.
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', ten);
    raise exception 'double booking should fail';
  exception when sqlstate 'P0001' then null;
  end;

  -- Off-grid or out-of-hours times are rejected.
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', ten + interval '7 minutes');
    raise exception 'off-grid booking should fail';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '11:45') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'booking past closing should fail';
  exception when sqlstate 'P0001' then null;
  end;
end $$;

-- Today's hours on the shop list run from the first barber in to the last
-- one out, by the shop's own clock, and leave out barbers who are away.
begin;
reset role;
do $$
declare
  today int := extract(dow from now() at time zone 'Asia/Kuala_Lumpur')::int;
begin
  delete from working_hours where barber_id = '00000000-0000-0000-0000-0000000000a2' and weekday = today;
  insert into working_hours (barber_id, weekday, opens_at, closes_at) values
    ('00000000-0000-0000-0000-0000000000a2', today, '10:00', '13:00'),
    ('00000000-0000-0000-0000-0000000000a2', today, '14:00', '19:30');
  assert (select opens_today = '09:00' and closes_today = '19:30' from find_shops()),
    'today''s hours should span every barber, across breaks';
  update barbers set is_active = false where id = '00000000-0000-0000-0000-0000000000a2';
  assert (select opens_today = '09:00' and closes_today = '12:00' from find_shops()),
    'barbers who are away should not count';
  update barbers set is_active = true where id = '00000000-0000-0000-0000-0000000000a2';
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', true, 'Day off', 0,
          (now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'Asia/Kuala_Lumpur',
          ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1)::timestamp at time zone 'Asia/Kuala_Lumpur');
  assert (select opens_today = '09:00' and closes_today = '12:00' from find_shops()),
    'a barber with the whole day off should not count';

  -- Kiritimati and Pago Pago are 25 hours apart, so never on the same day.
  delete from working_hours;
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  values ('00000000-0000-0000-0000-0000000000a1',
          extract(dow from now() at time zone 'Pacific/Kiritimati')::int, '09:00', '12:00');
  update shops set time_zone = 'Pacific/Kiritimati';
  assert (select opens_today = '09:00' from find_shops()), 'today should be the shop''s own day';
  update shops set time_zone = 'Pacific/Pago_Pago';
  assert (select opens_today is null and closes_today is null from find_shops()),
    'a day nobody works should have no hours';
end $$;
rollback;

-- The shop list's next free time: the earliest start for the shortest
-- service with any barber, today by the shop's clock, or else tomorrow.
begin;
reset role;
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  tz text;
  today date;
  tomorrow_nine timestamptz;
  next_free timestamptz;
begin
  -- A zone where it is now just past noon, so the times below hold whenever
  -- the test runs.
  select z into tz
  from generate_series(-12, 14) o,
       lateral (select 'Etc/GMT' || case when o > 0 then '-' || o when o < 0 then '+' || -o else '' end as z) n
  where extract(hour from now() at time zone z) = 12
  order by o
  limit 1;
  update shops set time_zone = tz;
  today := (now() at time zone tz)::date;
  tomorrow_nine := (today + 1 + time '09:00') at time zone tz;
  delete from bookings;
  -- Both barbers work 09:00-18:00 every day; the only service is a 30-minute haircut.
  update working_hours set closes_at = '18:00';

  next_free := (date_bin('15 minutes', now() at time zone tz, timestamp '2000-01-01') + interval '15 minutes')
               at time zone tz;
  assert (select next_free_at = next_free from find_shops()), 'free today: the next quarter hour';

  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  select shop, b, true, 'Busy', 0, (today + time '09:00') at time zone tz, (today + time '17:45') at time zone tz
  from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[]) b;
  assert (select next_free_at = tomorrow_nine from find_shops()), 'a full day moves it to tomorrow';

  -- 17:45 to closing fits a 15-minute line-up but not a haircut.
  insert into services (shop_id, name, duration_min, price, sort_order) values (shop, 'Line-up', 15, 10, 1);
  assert (select next_free_at = (today + time '17:45') at time zone tz from find_shops()),
    'the shortest service counts';
  update shops set is_published = false;
  assert not exists (select 1 from shops_next_free(array[shop])), 'a hidden shop has no free time';
  update shops set is_published = true;

  insert into shop_closures (shop_id, day) values (shop, today);
  assert (select next_free_at = tomorrow_nine from find_shops()), 'a shop closed today is free tomorrow';
  -- Time blocked from the evening before still counts the next morning.
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  select shop, b, true, 'Kenduri', 0, (today + time '20:00') at time zone tz, tomorrow_nine + interval '1 hour'
  from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[]) b;
  assert (select next_free_at = tomorrow_nine + interval '1 hour' from find_shops()),
    'a block from the evening before holds the morning';
  insert into shop_closures (shop_id, day) values (shop, today + 1);
  assert (select next_free_at is null from find_shops()), 'closed today and tomorrow: no next free time';
  delete from shop_closures where day = today + 1;
  delete from working_hours where weekday = extract(dow from today + 1)::int;
  assert (select next_free_at is null from find_shops()), 'closed today and nobody in tomorrow: none';

  set role anon;
  assert (select count(*) from find_shops()) = 1, 'guests still get the list';
  begin
    perform * from shops_next_free(array[shop]);
    raise exception 'only find_shops and my_shops should call shops_next_free';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- shops_next_free takes a shortcut, so check it against available_slots on a
-- messy diary at different times of day: bookings of odd lengths, a break,
-- blocks running past closing and over midnight.
begin;
reset role;
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  svc uuid := '00000000-0000-0000-0000-0000000000e1';
  tz text;
  today date;
  want timestamptz;
  k int := 0;
begin
  delete from bookings;
  delete from working_hours;
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select '00000000-0000-0000-0000-0000000000a1'::uuid, d, '08:00'::time, '13:00'::time from generate_series(0, 6) d
  union all
  select '00000000-0000-0000-0000-0000000000a1', d, '14:10', '22:00' from generate_series(0, 6) d
  union all
  select '00000000-0000-0000-0000-0000000000a2', d, '09:30', '23:50' from generate_series(0, 6) d;
  for hour in 0..23 loop
    select z into tz
    from generate_series(-12, 14) o,
         lateral (select 'Etc/GMT' || case when o > 0 then '-' || o when o < 0 then '+' || -o else '' end as z) n
    where extract(hour from now() at time zone z) = hour
    order by o
    limit 1;
    update shops set time_zone = tz;
    today := (now() at time zone tz)::date;
    delete from bookings;
    -- Back-to-back bookings of 20 to 95 minutes, with gaps that change with the hour.
    insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
    select shop, b, true, 'Busy', 0, at, at + make_interval(mins => 20 + (i * 37 + hour * 11) % 76)
    from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[])
           with ordinality as bb(b, n),
         generate_series(0, 30) i,
         lateral (select (today + time '07:00') at time zone tz
                         + make_interval(mins => i * (100 + n::int * 13) + (hour * 7) % 40) as at) x
    where (i + hour + n::int) % 4 <> 0;
    want := coalesce((select min(starts_at) from available_slots(svc, today)),
                     (select min(starts_at) from available_slots(svc, today + 1)));
    assert (select next_free_at from shops_next_free(array[shop])) is not distinct from want,
      format('at %s:00 next free should be %s, got %s', hour, want,
             (select next_free_at from shops_next_free(array[shop])));
    k := k + (want is not null)::int;
  end loop;
  assert k > 12, 'most hours should have a free time to compare';
end $$;
rollback;

-- The next free time at the edges of a day, each checked three ways: on its
-- own, on the shop list, and against the earliest of available_slots. A
-- haircut that just fits before closing and one that doesn't, a break, a
-- barber away or off, the whole day blocked, and tomorrow's first time once
-- today is over.
begin;
reset role;
create function pg_temp.next_free_is(p_want timestamptz, p_what text) returns void
language plpgsql as $f$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  svc uuid := '00000000-0000-0000-0000-0000000000e1';
  today date := (now() at time zone (select time_zone from shops where id = shop))::date;
  got timestamptz := (select next_free_at from shops_next_free(array[shop]));
  listed timestamptz := (select next_free_at from find_shops() where id = shop);
  slots timestamptz := coalesce((select min(starts_at) from available_slots(svc, today)),
                                (select min(starts_at) from available_slots(svc, today + 1)));
begin
  assert got is not distinct from p_want and listed is not distinct from p_want and slots is not distinct from p_want,
    format('%s: want %s, got %s, listed %s, available_slots %s', p_what, p_want, got, listed, slots);
end $f$;
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  ali uuid := '00000000-0000-0000-0000-0000000000a1';
  danial uuid := '00000000-0000-0000-0000-0000000000a2';
  both_ uuid[] := array[ali, danial];
  tz text;
  today date;
  -- The next quarter hour by the shop's clock, on the grid from a 09:00 opening.
  nq timestamp;
begin
  -- A zone where it is now between noon and one.
  select z into tz
  from generate_series(-12, 14) o,
       lateral (select 'Etc/GMT' || case when o > 0 then '-' || o when o < 0 then '+' || -o else '' end as z) n
  where extract(hour from now() at time zone z) = 12
  order by o
  limit 1;
  update shops set time_zone = tz where id = shop;
  today := (now() at time zone tz)::date;
  nq := date_bin('15 minutes', now() at time zone tz, timestamp '2000-01-01') + interval '15 minutes';
  delete from bookings;
  delete from shop_closures;
  update barbers set is_active = true where id = any(both_);
  -- The 30-minute haircut is the only service.
  update services set is_active = false where shop_id = shop and id <> '00000000-0000-0000-0000-0000000000e1';
  delete from working_hours where barber_id = any(both_);

  -- Closing half an hour after the next quarter: a haircut then just fits.
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select b, d, '09:00', (nq + interval '30 minutes')::time from unnest(both_) b, generate_series(0, 6) d;
  perform pg_temp.next_free_is(nq at time zone tz, 'a haircut that ends at closing time fits');
  -- A minute earlier and today is over: tomorrow at opening.
  update working_hours set closes_at = (nq + interval '29 minutes')::time where barber_id = any(both_);
  perform pg_temp.next_free_is((today + 1 + time '09:00') at time zone tz, 'a minute short of closing: tomorrow');

  -- A break: in until a quarter after the next quarter, too short for a
  -- haircut, and back two hours later at five past, on a grid of their own.
  delete from working_hours where barber_id = any(both_);
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select b, d, '09:00', (nq + interval '15 minutes')::time from unnest(both_) b, generate_series(0, 6) d
  union all
  select b, d, (nq + interval '2 hours 5 minutes')::time, '18:00' from unnest(both_) b, generate_series(0, 6) d;
  perform pg_temp.next_free_is((nq + interval '2 hours 5 minutes') at time zone tz, 'over a break: when they are back');
  -- Both booked from then until an end off the grid: the next time on it.
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  select shop, b, true, 'Busy', 0, (nq + interval '2 hours 5 minutes') at time zone tz,
         (nq + interval '2 hours 47 minutes') at time zone tz
  from unnest(both_) b;
  perform pg_temp.next_free_is((nq + interval '2 hours 50 minutes') at time zone tz,
    'after bookings that end off the grid');
  delete from bookings;

  -- A barber off. Ali is in 09:00-18:00 and booked for the next hour;
  -- Danial is in 08:00-20:00 and free.
  delete from working_hours where barber_id = any(both_);
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select ali, d, '09:00'::time, '18:00'::time from generate_series(0, 6) d
  union all
  select danial, d, '08:00', '20:00' from generate_series(0, 6) d;
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  values (shop, ali, true, 'Busy', 0, nq at time zone tz, (nq + interval '1 hour') at time zone tz);
  perform pg_temp.next_free_is(nq at time zone tz, 'one barber busy, the other free');
  assert (select opens_today = '08:00' and closes_today = '20:00' from shops_hours_today(array[shop])),
    'today''s hours run from the first in to the last out';
  update barbers set is_active = false where id = danial;
  perform pg_temp.next_free_is((nq + interval '1 hour') at time zone tz, 'a barber who is away doesn''t count');
  assert (select opens_today = '09:00' and closes_today = '18:00' from shops_hours_today(array[shop])),
    'a barber who is away is left out of today''s hours';
  update barbers set is_active = true where id = danial;
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  values (shop, danial, true, 'Day off', 0, today::timestamp at time zone tz, (today + 1)::timestamp at time zone tz);
  perform pg_temp.next_free_is((nq + interval '1 hour') at time zone tz, 'a barber with the whole day off doesn''t count');
  assert (select opens_today = '09:00' and closes_today = '18:00' from shops_hours_today(array[shop])),
    'a barber with the whole day off is left out of today''s hours';
  delete from bookings where barber_id = danial;
  delete from working_hours where barber_id = danial and weekday = extract(dow from today)::int;
  perform pg_temp.next_free_is((nq + interval '1 hour') at time zone tz, 'a barber who doesn''t work today doesn''t count');

  -- The whole day blocked for everyone: tomorrow at the first barber in, and
  -- no hours today.
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  values (danial, extract(dow from today)::int, '08:00', '20:00');
  delete from bookings;
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  select shop, b, true, 'Kenduri', 0, today::timestamp at time zone tz, (today + 1)::timestamp at time zone tz
  from unnest(both_) b;
  perform pg_temp.next_free_is((today + 1 + time '08:00') at time zone tz, 'the whole day blocked: tomorrow');
  assert (select opens_today is null and closes_today is null from shops_hours_today(array[shop])),
    'the whole day blocked: no hours today';
  assert (select opens_today is null from find_shops() where id = shop), 'the shop list shows it closed today';

  -- Today over: a zone where it is now nine at night, everyone gone home at
  -- six, and in again tomorrow at 09:10.
  select z into tz
  from generate_series(-12, 14) o,
       lateral (select 'Etc/GMT' || case when o > 0 then '-' || o when o < 0 then '+' || -o else '' end as z) n
  where extract(hour from now() at time zone z) = 21
  order by o
  limit 1;
  update shops set time_zone = tz where id = shop;
  today := (now() at time zone tz)::date;
  delete from bookings;
  delete from working_hours where barber_id = any(both_);
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select b, d, '09:10', '18:00' from unnest(both_) b, generate_series(0, 6) d;
  perform pg_temp.next_free_is((today + 1 + time '09:10') at time zone tz, 'today over: tomorrow''s first time');
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  select shop, b, true, 'Busy', 0, (today + 1 + time '09:10') at time zone tz, (today + 1 + time '09:50') at time zone tz
  from unnest(both_) b;
  perform pg_temp.next_free_is((today + 1 + time '09:55') at time zone tz,
    'today over and tomorrow''s first bookings taken: the next time on the grid');
end $$;
rollback;

-- Customers can't write bookings directly or see other people's -----------
do $$ begin
  insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at)
  values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1',
          '00000000-0000-0000-0000-0000000000c1', 'x', 0, now() + interval '1 day', now() + interval '1 day 1 hour');
  raise exception 'direct booking inserts should be blocked';
exception when insufficient_privilege then null;
end $$;

do $$ begin
  update profiles set role = 'barber' where id = auth.uid();
  raise exception 'customers should not be able to change their role';
exception when insufficient_privilege then null;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare v_id uuid;
begin
  assert (select count(*) from bookings) = 0, 'customers should not see other people''s bookings';
  reset role;
  select id into v_id from bookings limit 1;
  set role authenticated;
  begin
    perform set_booking_status(v_id, 'cancelled');
    raise exception 'customers should not cancel other people''s bookings';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

-- Customer cancels their own booking, freeing the slot -----------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  v_id uuid;
begin
  assert (select count(*) from bookings) = 2, 'customer should see their own bookings';
  select id into v_id from bookings where barber_id = '00000000-0000-0000-0000-0000000000a1';
  perform set_booking_status(v_id, 'cancelled');
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1')) = 11, 'cancelling should free the slot';
  begin
    perform set_booking_status(v_id, 'completed');
    raise exception 'customers should only be able to cancel';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- My bookings keeps the shop when it pauses ---------------------------------
begin;
do $$
declare v jsonb;
begin
  v := my_bookings();
  assert v -> 'waitlist' = my_waitlist(), 'the waiting lists come alongside: ' || (v -> 'waitlist')::text;
  v := v -> 'bookings';
  assert jsonb_array_length(v) = 2, 'my_bookings should list the customer''s two bookings';
  assert (select bool_and(e ->> 'customer_id' = '00000000-0000-0000-0000-0000000000c1') from jsonb_array_elements(v) e),
    'my_bookings should only list the caller''s own';
  assert (v -> 0 ->> 'starts_at')::timestamptz >= (v -> 1 ->> 'starts_at')::timestamptz, 'newest first';
  assert v -> 0 -> 'shops' ->> 'name' = 'Ali Cuts' and (v -> 0 -> 'shops' ->> 'is_live')::boolean
     and v -> 0 -> 'shops' ->> 'phone' = '012-345 6789' and v -> 0 -> 'shops' ->> 'slug' = 'ali-cuts'
     and v -> 0 -> 'barbers' ->> 'name' in ('Ali', 'Danial'),
    'each booking should come with its shop and barber';
  assert jsonb_array_length(my_bookings(1) -> 'bookings') = 1, 'p_limit caps the list';

  reset role;
  update shops set is_published = false where id = '00000000-0000-0000-0000-00000000005a';
  set role authenticated;
  assert (select count(*) from bookings b join shops s on s.id = b.shop_id) = 0,
    'a paused shop is hidden from its customers';
  v := my_bookings() -> 'bookings';
  assert jsonb_array_length(v) = 2
     and v -> 0 -> 'shops' ->> 'name' = 'Ali Cuts' and not (v -> 0 -> 'shops' ->> 'is_live')::boolean
     and v -> 0 -> 'shops' ->> 'phone' = '012-345 6789' and v -> 0 -> 'barbers' ->> 'name' is not null,
    'my_bookings should keep a paused shop''s details and say it is not live';
end $$;
rollback;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  assert my_bookings() = '{"bookings": [], "waitlist": [], "queue": []}', 'other customers see none of them';
end $$;
set role anon;
do $$ begin
  perform my_bookings();
  raise exception 'guests must not call my_bookings';
exception when insufficient_privilege then null;
end $$;
set role authenticated;

-- Names can't be cleared, and an account made without one is named after its email.
do $$ begin
  update profiles set full_name = '   ' where id = auth.uid();
  raise exception 'a blank name should be refused';
exception when check_violation then null;
end $$;
begin;
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d9', 'no.name@test');
do $$ begin
  assert (select full_name from profiles where id = '00000000-0000-0000-0000-0000000000d9') = 'no.name',
    'an account made without a name should be named after its email';
end $$;
rollback;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';

-- The owner sees all shop bookings and the customer's name ------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare v_id uuid;
begin
  assert (select count(*) from bookings) = 2, 'owner should see all shop bookings';
  assert (select full_name from profiles where id = '00000000-0000-0000-0000-0000000000c1') = 'Ben',
    'owner should see their customer''s name';
  assert (select count(*) from profiles where id = '00000000-0000-0000-0000-0000000000c2') = 0,
    'owner should not see unrelated customers';
  select id into v_id from bookings where status = 'confirmed';
  begin
    perform set_booking_status(v_id, 'no_show');
    raise exception 'no-show should wait until the appointment has started';
  exception when sqlstate '42501' then null;
  end;
end $$;

-- Once the appointment time has passed, the owner can mark a no-show.
reset role;
update bookings set starts_at = now() - interval '1 hour', ends_at = now() - interval '30 minutes'
where status = 'confirmed';
set role authenticated;
do $$
declare v_id uuid;
begin
  select id into v_id from bookings where status = 'confirmed';
  perform set_booking_status(v_id, 'no_show');
  assert (select status from bookings where id = v_id) = 'no_show', 'owner should mark no-shows';
end $$;

-- Barbers with booking history can't be deleted, only marked away.
do $$ begin
  delete from barbers where id = '00000000-0000-0000-0000-0000000000a2';
  raise exception 'deleting a barber with bookings should fail';
exception when foreign_key_violation then null;
end $$;

-- Hours are saved as a whole week, and overlapping ranges are rejected.
do $$ begin
  perform set_barber_hours('00000000-0000-0000-0000-0000000000a2',
    '[{"weekday": 1, "opens_at": "09:00", "closes_at": "13:00"},
      {"weekday": 1, "opens_at": "14:00", "closes_at": "18:00"}]');
  assert (select count(*) from working_hours where barber_id = '00000000-0000-0000-0000-0000000000a2') = 2,
    'set_barber_hours should replace the week';
  -- A Monday with a 13:00-14:00 break: 15 slots before, 15 after, none at 13:00.
  declare
    mon date := (now() at time zone 'Asia/Kuala_Lumpur')::date
                + (8 - extract(isodow from (now() at time zone 'Asia/Kuala_Lumpur')::date))::int;
  begin
    assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1', mon,
            '00000000-0000-0000-0000-0000000000a2')) = 30, 'a break should split the day''s slots';
    assert not exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', mon,
            '00000000-0000-0000-0000-0000000000a2')
            where starts_at = (mon + time '13:00') at time zone 'Asia/Kuala_Lumpur'), 'no slot inside the break';
  end;
  begin
    perform set_barber_hours('00000000-0000-0000-0000-0000000000a2',
      '[{"weekday": 2, "opens_at": "09:00", "closes_at": "13:00"},
        {"weekday": 2, "opens_at": "12:00", "closes_at": "18:00"}]');
    raise exception 'overlapping hours should fail';
  exception when sqlstate 'P0001' then null;
  end;
  assert (select count(*) from working_hours where barber_id = '00000000-0000-0000-0000-0000000000a2') = 2,
    'a failed save should keep the old hours';
end $$;

-- An expired trial hides the shop ---------------------------------------------
reset role;
update shops set trial_ends_at = now() - interval '1 day';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
set role authenticated;
do $$ begin
  assert (select count(*) from shops) = 0, 'shop with expired trial should be hidden';
  assert (select count(*) from find_shops()) = 0, 'shop with expired trial should not be listed';
  assert (select name = 'Ali Cuts' and not is_live from shop_public_status('ali-cuts')),
    'an expired trial''s link should say the shop is not live';
end $$;
reset role;
update shops set subscription_status = 'active';
set role authenticated;
do $$ begin
  assert (select count(*) from shops) = 1, 'paid shop should be visible again';
end $$;

-- The owner adds a WhatsApp booking and blocks time ----------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 3;
  b bookings;
begin
  b := add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '10:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Pak Abu', '019-111 2222', 'Booked on WhatsApp');
  assert b.guest_name = 'Pak Abu' and b.customer_id is null and b.price = 25,
    'guest booking should take the service name and price';
  assert b.ends_at - b.starts_at = interval '30 minutes', 'guest booking should last the service time';
  assert b.starts_at = (d + time '10:00') at time zone 'Asia/Kuala_Lumpur', 'time is shop-local';

  b := add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '13:00', 90,
    p_note => 'Friday prayers', p_is_block => true);
  assert b.is_block and b.service_name = 'Friday prayers' and b.price = 0, 'block should keep its reason';

  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '10:15', 30, p_guest_name => 'Clash');
    raise exception 'owner bookings must not overlap';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '16:00', 30);
    raise exception 'a non-block booking needs a name';
  exception when sqlstate '22023' then null;
  end;

  -- Online customers can't take those times.
  assert not exists (
    select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d, '00000000-0000-0000-0000-0000000000a1')
    where starts_at in ((d + time '10:00') at time zone 'Asia/Kuala_Lumpur',
                        (d + time '13:30') at time zone 'Asia/Kuala_Lumpur')
  ), 'guest bookings and blocks should hide those slots';

  -- A whole day off can't be blocked over existing bookings.
  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '00:00', 1440, p_is_block => true);
    raise exception 'a day off must not cover existing bookings';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 1, '00:00', 1441, p_is_block => true);
    raise exception 'blocks are at most a day';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 1, '09:00', 721, p_guest_name => 'Long');
    raise exception 'bookings are at most 12 hours';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- A whole day off hides every slot that day; removing it brings them back.
do $$
declare
  d date;
  b bookings;
begin
  select day into d
  from generate_series(1, 7) k, lateral (select (now() at time zone 'Asia/Kuala_Lumpur')::date + k as day) x
  where exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', x.day, '00000000-0000-0000-0000-0000000000a1'))
    and not exists (select 1 from bookings where barber_id = '00000000-0000-0000-0000-0000000000a1'
                    and status <> 'cancelled' and (starts_at at time zone 'Asia/Kuala_Lumpur')::date = x.day)
  order by day limit 1;
  assert d is not null, 'need an open day without bookings';

  b := add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '00:00', 1440,
    p_note => repeat('Hari Raya ', 20), p_is_block => true);
  assert length(b.service_name) = 80, 'a long reason should be shortened, not rejected';
  assert not exists (
    select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d, '00000000-0000-0000-0000-0000000000a1')
  ), 'a day off should hide every slot';

  perform set_booking_status(b.id, 'cancelled');
  assert exists (
    select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d, '00000000-0000-0000-0000-0000000000a1')
  ), 'removing the day off should bring the slots back';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1',
    (now() at time zone 'Asia/Kuala_Lumpur')::date + 3, '18:00', 30, p_guest_name => 'Sneaky');
  raise exception 'customers should not add shop bookings';
exception when sqlstate 'P0002' then null;
end $$;

-- Closing the shop for a few days -------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  svc uuid := '00000000-0000-0000-0000-0000000000e1';
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 40;
  off bookings;
begin
  -- One barber's day off doesn't close the shop, but the booking page hears that barber is off.
  off := add_shop_booking('00000000-0000-0000-0000-0000000000a2', d + 1, '00:00', 1440,
    p_note => 'Day off', p_is_block => true);
  assert (select count(*) from shop_closed_days(shop, d, d + 5) where barber_id is null) = 0,
    'one barber off is not a closed shop';
  assert (select array_agg(row(day, reason, is_closure, barber_id)::text) from shop_closed_days(shop, d, d + 5))
         = array[row(d + 1, 'Day off', false, '00000000-0000-0000-0000-0000000000a2'::uuid)::text],
    'that barber is off that day';

  assert close_shop_days(d, 3, '  Hari Raya  ') = 3, 'closing returns the number of days';
  assert (select array_agg(day order by day) from shop_closed_days(shop, d - 1, d + 5)) = array[d, d + 1, d + 2],
    'the three days should read as closed';
  assert (select bool_and(reason = 'Hari Raya' and is_closure) from shop_closed_days(shop, d, d + 2)),
    'the owner sees the reason, and that the shop was closed';
  assert not exists (select 1 from available_slots(svc, d + 2)), 'no slots on a closed day';
  assert exists (select 1 from available_slots(svc, d + 3)), 'the day after reopens';
  assert (select status from bookings where id = off.id) = 'confirmed', 'the barber''s own day off is left alone';

  -- Closing the same days again is harmless, and a new reason replaces the old.
  perform close_shop_days(d, 3, 'Hari Raya Aidilfitri');
  assert (select count(*) from shop_closed_days(shop, d, d + 5)) = 3, 'no doubles';
  assert (select bool_and(reason = 'Hari Raya Aidilfitri') from shop_closed_days(shop, d, d + 2)), 'the new reason';

  -- A barber who joins later is closed on those days too.
  insert into barbers (id, shop_id, name) values ('00000000-0000-0000-0000-0000000000a3', shop, 'Hakim');
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  values ('00000000-0000-0000-0000-0000000000a3', extract(dow from d + 1)::int, '14:00', '18:00');
  assert not exists (select 1 from available_slots(svc, d + 1)), 'a new barber is closed on closed days';
  delete from barbers where id = '00000000-0000-0000-0000-0000000000a3';

  -- Closed days are only changed through the functions.
  begin
    insert into shop_closures (shop_id, day) values (shop, d + 10);
    raise exception 'owners should not write closures directly';
  exception when insufficient_privilege then null;
  end;
  assert (select count(*) from shop_closures) = 0, 'closures are not read directly';

  begin
    perform close_shop_days(d, 0);
    raise exception 'zero days should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform close_shop_days(d - 41, 1);
    raise exception 'a day in the past should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform close_shop_days(d + 19, 3);
    raise exception 'days past the booking horizon should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform close_shop_days(null, 3);
    raise exception 'a missing start day should be refused';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- Customers see closed days without the reason, and can't close anything.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 40;
begin
  assert (select count(*) from shop_closed_days('00000000-0000-0000-0000-00000000005a', d, d + 5)
          where reason is null) = 3, 'customers see the closed days but not why';
  begin
    perform close_shop_days(d + 5, 1);
    raise exception 'customers should not close shops';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform reopen_shop_days(d, 3);
    raise exception 'customers should not reopen shops';
  exception when sqlstate 'P0002' then null;
  end;
  -- A booking on a day blocks closing it.
  perform book_appointment('00000000-0000-0000-0000-0000000000e1', (d + 5 + time '09:00') at time zone 'Asia/Kuala_Lumpur');
end $$;

reset role;
set role anon;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 40;
begin
  assert (select count(*) from shop_closed_days('00000000-0000-0000-0000-00000000005a', d, d + 5)) = 3,
    'guests see closed days too';
  begin
    perform close_shop_days(d + 5, 1);
    raise exception 'guests must not call close_shop_days';
  exception when insufficient_privilege then null;
  end;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 40;
begin
  begin
    perform close_shop_days(d + 4, 2, 'Kenduri');
    raise exception 'closing over a customer booking should be refused';
  exception when sqlstate 'P0001' then
    -- How many, and the first day, for the app to say.
    assert sqlerrm = format('There are bookings on those days (1, the first on %s). Cancel them first '
      '(and let the customers know), then close the shop.', to_char(d + 5, 'YYYY-MM-DD')), sqlerrm;
  end;
  assert (select count(*) from shop_closed_days(shop, d + 3, d + 6)) = 0, 'a refused closure leaves nothing behind';

  -- When every barber has the day off, the day reads as closed but isn't a closure.
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 7, '00:00', 1440, p_note => 'Kursus', p_is_block => true);
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a2', d + 7, '00:00', 1440, p_note => 'Kursus', p_is_block => true);
  assert (select not is_closure and reason = 'Kursus' and barber_id is null from shop_closed_days(shop, d + 7, d + 7)),
    'a day everyone is off reads as closed';
  -- Danial works Mondays only, so on another day Ali off is everyone who works it off.
  declare
    other date := d + 8 + (extract(dow from d + 8) = 1)::int;
  begin
    perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', other, '00:00', 1440, p_is_block => true);
    assert (select array_agg(row(day, is_closure, barber_id)::text) from shop_closed_days(shop, other, other))
           = array[row(other, false, null::uuid)::text], 'a barber who doesn''t work that weekday doesn''t keep it open';
  end;

  assert reopen_shop_days(d, 8) = 3, 'reopening counts the closed days it opened';
  assert (select array_agg(row(day, barber_id)::text order by day) from shop_closed_days(shop, d, d + 7))
         = array[row(d + 1, '00000000-0000-0000-0000-0000000000a2'::uuid)::text, row(d + 7, null::uuid)::text],
    'only the barbers'' own days off are left';
  assert (select count(*) from bookings where shop_id = shop and is_block and status = 'confirmed'
          and starts_at >= (d::timestamp at time zone 'Asia/Kuala_Lumpur')) = 4,
    'reopening leaves the barbers'' own days off alone';
  assert exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d + 2)),
    'the slots come back';
  assert reopen_shop_days(null, 3) = 0 and reopen_shop_days(d, null) = 0, 'nothing to reopen';
end $$;

-- Closing today works once the day's customers have been seen, and the shop
-- list shows the shop closed.
begin;
reset role;
insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at, status)
values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2',
        '00000000-0000-0000-0000-0000000000c1', 'Haircut', 25,
        now() - interval '10 minutes', now() - interval '5 minutes', 'confirmed');
set role authenticated;
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  assert (select opens_today = '09:00' from shop_hours_today(shop)), 'open today before closing';
  assert close_shop_days(today, 1) = 1, 'closing today should work once its customers have been';
  assert (select reason is null from shop_closed_days(shop, today, today)), 'no reason given';
  assert (select opens_today is null and closes_today is null from shop_hours_today(shop)),
    'a shop closed today has no hours today';
  assert (select opens_today is null from find_shops() where id = shop), 'the shop list shows it closed';
end $$;
rollback;

-- Tidy up so the limits below start from a clean diary.
reset role;
delete from bookings where (starts_at at time zone 'Asia/Kuala_Lumpur')::date
  >= (now() at time zone 'Asia/Kuala_Lumpur')::date + 39;

-- Moving a booking -----------------------------------------------------------
-- Both barbers work 09:00-12:00 every day again. On day +5 Ali has an errand
-- at 09:00 and a WhatsApp customer at 11:00.
reset role;
delete from working_hours where barber_id = '00000000-0000-0000-0000-0000000000a2';
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a2', d, '09:00', '12:00' from generate_series(0, 6) d;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
begin
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '09:00', 30,
    p_note => 'Errand', p_is_block => true);
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '11:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Pak Abu');
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  ten timestamptz := (d + time '10:00') at time zone 'Asia/Kuala_Lumpur';
  b bookings;
  moved bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', ten, '00000000-0000-0000-0000-0000000000a1', 'keep the top long');

  -- The booking's own time is free to the customer moving it, and to nobody else.
  assert not exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1') where starts_at = ten + interval '15 minutes'),
    'a booked time should not be free';
  assert exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1', b.id) where starts_at = ten + interval '15 minutes'),
    'leaving the booking out should free its own time';

  -- 15 minutes later overlaps the old time, which must not count as taken.
  moved := reschedule_booking(b.id, ten + interval '15 minutes');
  assert moved.id = b.id, 'a move should change the booking, not make a new one';
  assert moved.starts_at = ten + interval '15 minutes' and moved.ends_at = ten + interval '45 minutes',
    'the booking should move and keep the service length';
  assert moved.barber_id = '00000000-0000-0000-0000-0000000000a1', 'any barber should keep the same barber when free';
  assert moved.customer_note = 'keep the top long' and moved.price = 25 and moved.service_name = 'Haircut'
     and moved.status = 'confirmed', 'a move should keep the note, price and service';
  assert (select count(*) from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
          and status = 'confirmed' and starts_at > now()) = 1, 'a move should not add a booking';
  assert exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d,
          '00000000-0000-0000-0000-0000000000a1') where starts_at = ten - interval '15 minutes'),
    'the old time should be free again';

  -- Not onto someone else's booking or blocked time with the same barber.
  begin
    perform reschedule_booking(b.id, (d + time '11:00') at time zone 'Asia/Kuala_Lumpur', '00000000-0000-0000-0000-0000000000a1');
    raise exception 'moving onto a booked time should fail';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Sorry, that time was just taken. Please pick another.', 'unexpected message: ' || sqlerrm;
  end;
  begin
    perform reschedule_booking(b.id, (d + time '09:00') at time zone 'Asia/Kuala_Lumpur', '00000000-0000-0000-0000-0000000000a1');
    raise exception 'moving onto blocked time should fail';
  exception when sqlstate 'P0001' then null;
  end;
  begin
    perform reschedule_booking(b.id, (d + time '12:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'moving past closing should fail';
  exception when sqlstate 'P0001' then null;
  end;

  -- With any barber, a time the current barber can't do goes to a free one.
  moved := reschedule_booking(b.id, (d + time '11:00') at time zone 'Asia/Kuala_Lumpur');
  assert moved.barber_id = '00000000-0000-0000-0000-0000000000a2', 'any barber should fall back to a free barber';

  -- A cancelled booking can't be moved.
  begin
    perform reschedule_booking((select id from bookings where status = 'cancelled'
                                and customer_id = '00000000-0000-0000-0000-0000000000c1' limit 1),
                               (d + time '10:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'a cancelled booking should not move';
  exception when sqlstate '42501' then
    assert sqlerrm = 'You can only change an upcoming booking.', 'unexpected message: ' || sqlerrm;
  end;
end $$;

-- Nobody else can move it.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare v_id uuid;
begin
  reset role;
  select id into v_id from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  set role authenticated;
  assert not exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1',
          (now() at time zone 'Asia/Kuala_Lumpur')::date + 5, '00000000-0000-0000-0000-0000000000a2', v_id)
          where starts_at = ((now() at time zone 'Asia/Kuala_Lumpur')::date + 5 + time '11:00') at time zone 'Asia/Kuala_Lumpur'),
    'other people''s bookings should stay taken';
  begin
    perform reschedule_booking(v_id, ((now() at time zone 'Asia/Kuala_Lumpur')::date + 5 + time '10:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'customers should not move other people''s bookings';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

-- The shop moves it too (the customer called to come later), and it stays the
-- customer's booking. Blocked time never moves.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  v bookings;
  moved bookings;
begin
  select * into v from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  moved := reschedule_booking(v.id, (d + time '11:30') at time zone 'Asia/Kuala_Lumpur');
  assert moved.id = v.id and moved.customer_id = v.customer_id and moved.barber_id = v.barber_id
     and moved.starts_at = (d + time '11:30') at time zone 'Asia/Kuala_Lumpur'
     and moved.customer_note = v.customer_note and moved.price = v.price,
    'the shop should move the customer''s own booking, with the same barber, note and price';
  begin
    perform reschedule_booking(v.id, (d + time '11:00') at time zone 'Asia/Kuala_Lumpur', '00000000-0000-0000-0000-0000000000a1');
    raise exception 'the shop should not move a booking onto a taken time';
  exception when sqlstate 'P0001' then null;
  end;
  moved := reschedule_booking(v.id, v.starts_at);
  assert moved.starts_at = v.starts_at, 'and back again';
  begin
    perform reschedule_booking((select id from bookings where is_block and status = 'confirmed' and starts_at > now() limit 1),
                               (d + time '10:30') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'blocked time should not move';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

-- Reminders ------------------------------------------------------------------
-- The shop records that it WhatsApped a customer, for the time the message
-- named, and moving the booking clears it. A second shop's owner is added for
-- this part only.
begin;
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'hakim@test', '{"full_name":"Hakim","phone":"011-2233 4455"}'),
  ('00000000-0000-0000-0000-0000000000c4', 'farid@test', '{"full_name":"Farid","phone":"012-778 9012"}'),
  -- A father and daughter on one phone.
  ('00000000-0000-0000-0000-0000000000c5', 'ahseng@test', '{"full_name":"Ah Seng","phone":"019-888 7777"}'),
  ('00000000-0000-0000-0000-0000000000c6', 'meiling@test', '{"full_name":"Mei Ling","phone":"019-888 7777"}');
insert into shops (owner_id, name, slug) values ('00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  v bookings;
  b bookings;
begin
  select * into v from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  assert v.reminded_at is null, 'a booking starts out not reminded';
  b := mark_booking_reminded(v.id, v.starts_at);
  assert b.id = v.id and b.reminded_at = now(), 'the owner should mark a booking as reminded';

  -- A message that never went out can be taken back, and marked again.
  b := mark_booking_reminded(v.id, v.starts_at, false);
  assert b.reminded_at is null, 'the owner should take a reminder back';
  b := mark_booking_reminded(v.id, v.starts_at);
  assert b.reminded_at = now(), 'the owner should mark it again';
  -- For the next owner to try, who can't see it.
  perform set_config('test.reminded_booking', v.id::text, false);

  -- Not blocked time, a cancelled booking, or one that doesn't exist.
  begin
    perform mark_booking_reminded(id, starts_at) from bookings where is_block and status = 'confirmed' and starts_at > now() limit 1;
    raise exception 'blocked time should not be reminded';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform mark_booking_reminded(id, starts_at) from bookings where status = 'cancelled' and not is_block limit 1;
    raise exception 'a cancelled booking should not be reminded';
  exception when sqlstate '42501' then
    assert sqlerrm = 'You can only remind a customer about an upcoming booking.', 'unexpected message: ' || sqlerrm;
  end;
  begin
    perform mark_booking_reminded(gen_random_uuid(), now() + interval '1 day');
    raise exception 'an unknown booking should not be found';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

-- Only that shop's owner: not another shop's owner, nor the customer.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  perform mark_booking_reminded(current_setting('test.reminded_booking')::uuid, now() + interval '1 day', false);
  raise exception 'another shop''s owner should not change it';
exception when sqlstate 'P0002' then null;
end $$;
do $$ begin
  perform reschedule_booking(current_setting('test.reminded_booking')::uuid,
                             ((now() at time zone 'Asia/Kuala_Lumpur')::date + 5 + time '11:30') at time zone 'Asia/Kuala_Lumpur');
  raise exception 'another shop''s owner should not move it';
exception when sqlstate 'P0002' then null;
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  v bookings;
  moved bookings;
begin
  select * into v from bookings where customer_id = auth.uid() and status = 'confirmed' and starts_at > now();
  begin
    perform mark_booking_reminded(v.id, v.starts_at);
    raise exception 'the customer should not mark their own booking';
  exception when sqlstate 'P0002' then null;
  end;
  assert v.reminded_at is not null, 'the customer sees it was reminded';

  -- The reminder named the old time, so a move clears it.
  moved := reschedule_booking(v.id, (d + time '10:00') at time zone 'Asia/Kuala_Lumpur');
  assert moved.reminded_at is null, 'moving a booking should clear its reminder';
end $$;

-- A reminder sent from a screen that still showed the old time doesn't count
-- for the new one.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  v bookings;
  b bookings;
begin
  select * into v from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  assert v.starts_at = (d + time '10:00') at time zone 'Asia/Kuala_Lumpur', 'the booking should have moved';
  begin
    perform mark_booking_reminded(v.id, v.starts_at - interval '1 day');
    raise exception 'a reminder for the old time should not be saved';
  exception when sqlstate '42501' then
    assert sqlerrm = 'This booking has changed. Check the new time.', 'unexpected message: ' || sqlerrm;
  end;
  assert (select reminded_at is null from bookings where id = v.id), 'the moved booking should still need a reminder';
  begin
    perform mark_booking_reminded(v.id, null);
    raise exception 'a reminder with no time should not be saved';
  exception when sqlstate '42501' then null;
  end;
  b := mark_booking_reminded(v.id, v.starts_at);
  assert b.reminded_at = now(), 'a reminder for the new time should be saved';
end $$;

reset role;
set role anon;
do $$ begin
  perform mark_booking_reminded(gen_random_uuid(), now());
  raise exception 'guests must not call mark_booking_reminded';
exception when insufficient_privilege then null;
end $$;

-- Once it has started, it is too late to remind, or to take a reminder back.
reset role;
update bookings set starts_at = now() - interval '5 minutes', ends_at = now() + interval '25 minutes'
where customer_id = '00000000-0000-0000-0000-0000000000c1' and status = 'confirmed' and starts_at > now();
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  v bookings;
begin
  select * into v from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at = now() - interval '5 minutes';
  begin
    perform mark_booking_reminded(v.id, v.starts_at);
    raise exception 'a booking that has started should not be reminded';
  exception when sqlstate '42501' then
    assert sqlerrm = 'You can only remind a customer about an upcoming booking.', 'unexpected message: ' || sqlerrm;
  end;
  begin
    perform mark_booking_reminded(v.id, v.starts_at, false);
    raise exception 'a booking that has started should keep its reminder';
  exception when sqlstate '42501' then null;
  end;
  assert (select reminded_at is not null from bookings where id = v.id), 'the reminder should stay';
end $$;
rollback;

-- Once its time has passed, the customer can't move it.
reset role;
update bookings set starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '30 minutes'
where customer_id = '00000000-0000-0000-0000-0000000000c1' and status = 'confirmed' and starts_at > now();
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
set role authenticated;
do $$
declare v_id uuid;
begin
  select id into v_id from bookings where status = 'confirmed' and starts_at < now() - interval '1 day';
  begin
    perform reschedule_booking(v_id, ((now() at time zone 'Asia/Kuala_Lumpur')::date + 5 + time '10:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'a past booking should not move';
  exception when sqlstate '42501' then null;
  end;
end $$;

reset role;
set role anon;
do $$ begin
  perform reschedule_booking(gen_random_uuid(), now() + interval '1 day');
  raise exception 'guests must not call reschedule_booking';
exception when insufficient_privilege then null;
end $$;

-- The shop's customers -------------------------------------------------------
-- A fresh diary for this part only: regulars, guests typed different ways,
-- and things that are not customers. Days count back from today in Kajang,
-- at set clock times, so it reads the same at any hour.
begin;
reset role;
delete from bookings;
update profiles set phone = '013-222 3333' where id = '00000000-0000-0000-0000-0000000000c2';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'hakim@test', '{"full_name":"Hakim","phone":"011-2233 4455"}'),
  ('00000000-0000-0000-0000-0000000000c4', 'farid@test', '{"full_name":"Farid","phone":"012-778 9012"}'),
  -- A father and daughter on one phone.
  ('00000000-0000-0000-0000-0000000000c5', 'ahseng@test', '{"full_name":"Ah Seng","phone":"019-888 7777"}'),
  ('00000000-0000-0000-0000-0000000000c6', 'meiling@test', '{"full_name":"Mei Ling","phone":"019-888 7777"}');
insert into shops (owner_id, name, slug) values ('00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
insert into bookings (shop_id, barber_id, customer_id, guest_name, guest_phone, is_block, service_name, price,
                      starts_at, ends_at, status)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', f.customer_id::uuid,
       f.guest_name, f.guest_phone, f.is_block, 'Haircut', 25, x.at, x.at + interval '30 minutes',
       f.status::booking_status
from (values
  -- Ben comes every three weeks; two cuts on one day are one visit, and a no-show isn't one.
  ('00000000-0000-0000-0000-0000000000c1', null, null, false, -70, '09:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c1', null, null, false, -49, '09:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c1', null, null, false, -49, '09:30', 'completed'),
  ('00000000-0000-0000-0000-0000000000c1', null, null, false, -28, '09:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c1', null, null, false, -14, '09:00', 'no_show'),
  -- Chong came once and is booked again; a cancelled booking doesn't count.
  ('00000000-0000-0000-0000-0000000000c2', null, null, false, -40, '10:00', 'cancelled'),
  ('00000000-0000-0000-0000-0000000000c2', null, null, false, -20, '10:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c2', null, null, false, 3, '10:00', 'confirmed'),
  -- One WhatsApp guest, his number typed two ways; his 30 days are up today.
  (null, 'Pak Abu', '019-111 2222', false, -60, '10:30', 'completed'),
  (null, 'Abu', '+60 19-111 2222', false, -30, '10:30', 'completed'),
  -- Overdue, but already booked.
  (null, 'Kamal', '012-555 0000', false, -50, '11:00', 'completed'),
  (null, 'Kamal', '012-555 0000', false, -25, '11:00', 'completed'),
  (null, 'Kamal', '012-555 0000', false, 5, '11:00', 'confirmed'),
  -- A walk-in with no number, his name typed two ways.
  (null, 'Uncle Lim', null, false, -10, '11:30', 'completed'),
  (null, 'uncle  LIM', null, false, -3, '11:30', 'completed'),
  -- One visit: due after four weeks, until 90 days have gone by.
  (null, 'Zaki', '011-1234 5678', false, -40, '12:00', 'completed'),
  (null, 'Old Timer', '017-000 1111', false, -200, '12:30', 'completed'),
  -- Gaps of 10, 20, 30 and 25 days: the median is 22.5, so 23.
  (null, 'Median', '016-000 2222', false, -130, '13:00', 'completed'),
  (null, 'Median', '016-000 2222', false, -120, '13:00', 'completed'),
  (null, 'Median', '016-000 2222', false, -100, '13:00', 'completed'),
  (null, 'Median', '016-000 2222', false, -70, '13:00', 'completed'),
  (null, 'Median', '016-000 2222', false, -45, '13:00', 'completed'),
  -- Not marked done, but the time has passed: a visit.
  (null, 'Kumar', '016-210 3398', false, -2, '13:30', 'confirmed'),
  -- Two days running: the usual gap is still at least a week.
  (null, 'Twice', '018-000 3333', false, -6, '14:00', 'completed'),
  (null, 'Twice', '018-000 3333', false, -5, '14:00', 'completed'),
  -- Never came: listed, with the no-show.
  (null, 'Flake', '012-444 5555', false, -8, '16:30', 'no_show'),
  -- Walk-ins added with no name are saved as 'Walk-in'. With no number
  -- either, they are nobody in particular, not one regular.
  (null, 'Walk-in', null, false, -40, '17:00', 'completed'),
  (null, 'Walk-in', null, false, -33, '17:00', 'completed'),
  (null, 'Walk-in', null, false, -26, '17:00', 'completed'),
  (null, 'Walk-in', '', false, -19, '17:00', 'completed'),
  (null, ' walk-in', null, false, -12, '17:00', 'completed'),
  -- With a number, they are that number, with no name to show.
  (null, 'Walk-in', '017-555 1234', false, -9, '17:30', 'completed'),
  -- Daniel, once added in a hurry with only his number, keeps his name.
  (null, 'Daniel Tan', '016-778 2301', false, -60, '12:00', 'completed'),
  (null, 'Daniel Tan', '016-778 2301', false, -32, '12:00', 'completed'),
  (null, 'Walk-in', '0167782301', false, -4, '12:00', 'completed'),
  -- Guests under an online customer's number are that customer: Hakim
  -- WhatsApped twice, then booked online; Farid booked online, then WhatsApped.
  (null, 'Hakim', '011-2233 4455', false, -70, '11:00', 'completed'),
  (null, 'Hakim', '011-2233 4455', false, -42, '11:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c3', null, null, false, 1, '11:00', 'confirmed'),
  ('00000000-0000-0000-0000-0000000000c4', null, null, false, -70, '10:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c4', null, null, false, -42, '10:00', 'completed'),
  (null, 'Farid', '+60 12-778 9012', false, -7, '10:00', 'completed'),
  -- But not a number two of the shop's customers share.
  ('00000000-0000-0000-0000-0000000000c5', null, null, false, -15, '10:00', 'completed'),
  ('00000000-0000-0000-0000-0000000000c6', null, null, false, -16, '10:00', 'completed'),
  (null, 'Wei Ming', '019-888 7777', false, -10, '15:00', 'completed'),
  -- Not customers: only cancelled, a deleted account, blocked time, and over two years ago.
  (null, 'Ghost', '019-999 0000', false, -10, '14:30', 'cancelled'),
  (null, 'Deleted account', null, false, -15, '15:00', 'completed'),
  (null, null, null, true, -1, '15:30', 'confirmed'),
  (null, 'Ancient', '012-777 8888', false, -800, '16:00', 'completed')
) f(customer_id, guest_name, guest_phone, is_block, days, clock, status),
lateral (select ((now() at time zone 'Asia/Kuala_Lumpur')::date + f.days + f.clock::time)
                at time zone 'Asia/Kuala_Lumpur' as at) x;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  at_ text := 'Asia/Kuala_Lumpur';
  r record;
begin
  -- Due first, longest overdue first (Median 22 days, Zaki 12, Ben 7, Abu 0),
  -- then everyone else by their last visit, with nothing yet last.
  assert (select array_agg(name) from shop_customers()) =
         array['Median', 'Zaki', 'Ben', 'Abu', 'Kumar', 'uncle  LIM', 'Daniel Tan', 'Twice', 'Farid', null,
               'Wei Ming', 'Ah Seng', 'Mei Ling', 'Chong', 'Kamal', 'Hakim', 'Old Timer', 'Flake'],
    'unexpected list: ' || (select array_agg(name)::text from shop_customers());
  assert (select bool_and(total_count = 18 and due_count = 4) from shop_customers()), 'counts are for everyone';
  assert (select array_agg(name) from shop_customers() where is_due) = array['Median', 'Zaki', 'Ben', 'Abu'],
    'four are due';

  select * into r from shop_customers() where name = 'Ben';
  assert r.customer_key = 'c:00000000-0000-0000-0000-0000000000c1' and r.customer_id = '00000000-0000-0000-0000-0000000000c1',
    'an online customer is their account';
  assert r.visits = 3 and r.no_shows = 1 and r.usual_gap_days = 21 and r.phone is null and r.next_booking_at is null,
    'Ben: three visits, a no-show, every three weeks: ' || row(r.*)::text;
  assert r.last_visit_at = (today - 28 + time '09:00') at time zone at_, 'Ben''s last cut';

  select * into r from shop_customers() where name = 'Chong';
  assert r.visits = 1 and r.phone = '013-222 3333' and not r.is_due
     and r.next_booking_at = (today + 3 + time '10:00') at time zone at_, 'Chong is booked: ' || row(r.*)::text;

  select * into r from shop_customers() where customer_key = 'p:60191112222';
  assert r.name = 'Abu' and r.phone = '+60 19-111 2222' and r.customer_id is null and r.visits = 2
     and r.usual_gap_days = 30 and r.is_due, 'one guest per number, as last given: ' || row(r.*)::text;
  assert (select is_due is false and next_booking_at is not null from shop_customers() where name = 'Kamal'),
    'someone already booked is not due';
  select * into r from shop_customers() where customer_key = 'n:uncle lim';
  assert r.name = 'uncle  LIM' and r.phone is null and r.visits = 2 and r.usual_gap_days = 7 and not r.is_due,
    'a guest with no number is one person per name: ' || row(r.*)::text;
  assert (select usual_gap_days = 28 and is_due from shop_customers() where name = 'Zaki'), 'one visit: four weeks';
  assert (select usual_gap_days = 28 and not is_due from shop_customers() where name = 'Old Timer'),
    'after 90 days they are no longer due';
  assert (select usual_gap_days = 23 from shop_customers() where name = 'Median'), 'the median gap, halves up';
  assert (select visits = 1 and last_visit_at = (today - 2 + time '13:30') at time zone at_
          from shop_customers() where name = 'Kumar'), 'a past booking not marked done is a visit';
  assert (select usual_gap_days = 7 and not is_due from shop_customers() where name = 'Twice'), 'at least a week';
  assert (select visits = 0 and no_shows = 1 and last_visit_at is null and not is_due
          from shop_customers() where name = 'Flake'), 'someone who never came';

  -- Walk-ins added with no name.
  assert not exists (select 1 from shop_customers() where name ilike '%walk-in%' or customer_key like 'n:%walk%'),
    'walk-ins with no name or number are not a customer';
  select * into r from shop_customers() where customer_key = 'p:60175551234';
  assert r.name is null and r.phone = '017-555 1234' and r.visits = 1 and not r.is_due,
    'a walk-in with only a number: ' || row(r.*)::text;
  select * into r from shop_customers() where customer_key = 'p:60167782301';
  assert r.name = 'Daniel Tan' and r.phone = '0167782301' and r.visits = 3 and r.usual_gap_days = 28
     and r.last_visit_at = (today - 4 + time '12:00') at time zone at_, 'the name he last gave: ' || row(r.*)::text;

  -- Guests under an online customer's number.
  select * into r from shop_customers() where name = 'Hakim';
  assert r.customer_key = 'c:00000000-0000-0000-0000-0000000000c3' and r.phone = '011-2233 4455' and r.visits = 2
     and not r.is_due and r.next_booking_at = (today + 1 + time '11:00') at time zone at_,
    'Hakim''s WhatsApp visits and online booking are one customer: ' || row(r.*)::text;
  select * into r from shop_customers() where name = 'Farid';
  assert r.customer_key = 'c:00000000-0000-0000-0000-0000000000c4' and r.visits = 3 and r.usual_gap_days = 32
     and not r.is_due and r.last_visit_at = (today - 7 + time '10:00') at time zone at_,
    'Farid''s cut by WhatsApp counts on his account: ' || row(r.*)::text;
  assert (select count(*) from shop_customers() where customer_key in ('p:601122334455', 'p:60127789012')) = 0,
    'and they are not listed twice';
  select * into r from shop_customers() where name = 'Wei Ming';
  assert r.customer_key = 'p:60198887777' and r.customer_id is null,
    'a number two accounts share stays a guest: ' || row(r.*)::text;
  assert (select array_agg(customer_key) from shop_customers('0112233')) = array['c:00000000-0000-0000-0000-0000000000c3'],
    'search finds Hakim once';

  -- Search: a name, or a number however it is typed. Not a pattern.
  assert (select array_agg(name) from shop_customers('  ABU ')) = array['Abu'], 'search by name';
  assert (select array_agg(name) from shop_customers('0191112')) = array['Abu'], 'search by number';
  assert (select array_agg(name) from shop_customers('+60 19-111')) = array['Abu'], 'search by number as written';
  assert (select array_agg(name) from shop_customers('013-222')) = array['Chong'], 'search an account''s number';
  assert (select array_agg(name order by name) from shop_customers('2222')) = array['Abu', 'Median'], 'digits anywhere';
  assert (select array_agg(name) from shop_customers('lim')) = array['uncle  LIM'], 'search ignores case';
  assert (select count(*) from shop_customers('%')) = 0, 'search text is not a pattern';
  assert (select bool_and(total_count = 2 and due_count = 2) from shop_customers('2222')), 'counts follow the search';

  -- Pages.
  assert (select array_agg(name) from shop_customers(null, 2, 0)) = array['Median', 'Zaki'], 'first page';
  assert (select array_agg(name) from shop_customers(null, 2, 2)) = array['Ben', 'Abu'], 'second page';
  assert (select array_agg(name) from shop_customers(null, 2, 16)) = array['Old Timer', 'Flake'], 'last page';
  assert (select count(*) from shop_customers(null, 2, 18)) = 0, 'past the end';
  assert (select count(*) from shop_customers(null, 0, 0)) = 1 and (select count(*) from shop_customers(null, null, -5)) = 18,
    'odd page sizes are made sensible';

  -- My shop's card gets the same two numbers without the list.
  assert shop_cards(today, today) -> 'customers' = '{"total": 18, "due": 4}',
    'the card counts everyone, and who is due: ' || (shop_cards(today, today) -> 'customers')::text;
end $$;

-- Moved bookings: Chong's next cut three days later, which leaves him booked,
-- and Zaki's cut put down 20 days later than it was, so he isn't due yet.
reset role;
update bookings set starts_at = starts_at + interval '3 days', ends_at = ends_at + interval '3 days',
                    customer_change = 'moved', customer_changed_at = now()
where customer_id = '00000000-0000-0000-0000-0000000000c2' and status = 'confirmed';
update bookings set starts_at = starts_at + interval '20 days', ends_at = ends_at + interval '20 days'
where guest_name = 'Zaki';
set role authenticated;
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  cards jsonb := shop_cards(today, today) -> 'customers';
begin
  assert cards = '{"total": 18, "due": 3}', 'moves count where they are now: ' || cards::text;
  assert cards = (select jsonb_build_object('total', total_count, 'due', due_count) from shop_customers(null, 1, 0)),
    'as the list says';
end $$;

-- A page is at most 50.
reset role;
insert into bookings (shop_id, barber_id, guest_name, guest_phone, service_name, price, starts_at, ends_at, status)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', 'Guest ' || k,
       '012-900 ' || lpad(k::text, 4, '0'), 'Haircut', 25, x.at, x.at + interval '30 minutes', 'completed'
from generate_series(1, 60) k,
     lateral (select ((now() at time zone 'Asia/Kuala_Lumpur')::date - k + time '16:00') at time zone 'Asia/Kuala_Lumpur' as at) x;
set role authenticated;
do $$ begin
  assert (select count(*) from shop_customers(null, 1000, 0)) = 50, 'a page is capped at 50';
  assert (select total_count from shop_customers(null, 1, 0)) = 78, 'the count still has everyone';
  assert shop_cards(current_date, current_date) -> 'customers'
         = (select jsonb_build_object('total', total_count, 'due', due_count) from shop_customers(null, 1, 0)),
    'and so does the card';
end $$;

-- Nobody else sees them: not a customer, another shop's owner, or a guest.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert (select count(*) from shop_customers()) = 0, 'customers have no customer list';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  assert (select count(*) from shop_customers()) = 0, 'another shop''s owner sees none of them';
end $$;
reset role;
set role anon;
do $$ begin
  perform shop_customers();
  raise exception 'guests must not call shop_customers';
exception when insufficient_privilege then null;
end $$;
rollback;

-- A returning customer's next cut and their barbers ----------------------------
-- Find a barber's cards: Ben's soonest booking, and the shops he had cuts at,
-- most recent first, with what Book again needs. Three more shops for this
-- part only: one open all day, one paused, and one he left long ago.
begin;
reset role;
delete from bookings;
update shops set is_published = true, trial_ends_at = now() + interval '30 days'
where id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}'),
  ('00000000-0000-0000-0000-0000000000b3', 'owner3@test', '{"role":"barber","full_name":"Mat"}'),
  ('00000000-0000-0000-0000-0000000000b4', 'owner4@test', '{"role":"barber","full_name":"Irfan"}');
insert into shops (id, owner_id, name, slug, is_published) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts', true),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000b3', 'Paused Cuts', 'paused-cuts', false),
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000b4', 'Old Cuts', 'old-cuts', true);
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005b', 'Rahman'),
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000005c', 'Mat'),
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-00000000005d', 'Irfan');
insert into services (id, shop_id, name, duration_min, price) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000005b', 'Fade', 40, 22),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000005c', 'Haircut', 30, 15),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000005d', 'Haircut', 30, 15);
-- Kemas is open all day every day, so it always has a next free time.
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a3', d, '00:00', '23:45' from generate_series(0, 6) d;
insert into bookings (shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at, status)
select f.shop_id::uuid, f.barber_id::uuid, f.service_id::uuid, f.customer_id::uuid, f.service_name, 20,
       x.at, x.at + interval '30 minutes', f.status::booking_status
from (values
  -- Ben at Ali Cuts every three weeks, the last with Danial; a no-show isn't a
  -- visit, two cuts on one day are one, and one over two years ago is too old.
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -800, '09:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -70, '09:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -49, '09:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', null,
   '00000000-0000-0000-0000-0000000000c1', 'Beard trim', -49, '09:30', 'completed'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -28, '09:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -14, '09:00', 'no_show'),
  -- His latest cut was at Kemas, and he is booked there again tomorrow.
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000c1', 'Fade', -10, '10:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000c1', 'Fade', 1, '10:00', 'confirmed'),
  -- And at Ali Cuts later on.
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', 3, '09:00', 'confirmed'),
  -- Not marked done, but its time has passed: a visit, at a shop since paused.
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000e3',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -40, '10:00', 'confirmed'),
  -- The fourth shop back is left out, and a cancelled booking isn't one to come.
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000e4',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', -100, '10:00', 'completed'),
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000e4',
   '00000000-0000-0000-0000-0000000000c1', 'Haircut', 2, '10:00', 'cancelled'),
  -- Chong's cut is his own.
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c2', 'Haircut', -5, '09:00', 'completed')
) f(shop_id, barber_id, service_id, customer_id, service_name, days, clock, status),
lateral (select ((now() at time zone 'Asia/Kuala_Lumpur')::date + f.days + f.clock::time)
                at time zone 'Asia/Kuala_Lumpur' as at) x;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
set role authenticated;
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  at_ text := 'Asia/Kuala_Lumpur';
  m jsonb := my_shops();
  s jsonb;
  listed record;
begin
  assert (select array_agg(x ->> 'name') from jsonb_array_elements(m -> 'shops') x)
         = array['Kemas Cuts', 'Ali Cuts', 'Paused Cuts'], 'most recent first, at most three: ' || m::text;

  s := m -> 'shops' -> 0;
  select * into listed from find_shops() where id = '00000000-0000-0000-0000-00000000005b';
  assert s ->> 'shop_id' = '00000000-0000-0000-0000-00000000005b' and s ->> 'slug' = 'kemas-cuts'
     and s ->> 'time_zone' = at_ and (s ->> 'is_live')::boolean
     and s ->> 'service_id' = '00000000-0000-0000-0000-0000000000e2' and s ->> 'service_name' = 'Fade'
     and s ->> 'barber_id' = '00000000-0000-0000-0000-0000000000a3' and s ->> 'barber_name' = 'Rahman'
     and (s ->> 'visits')::int = 1 and (s ->> 'usual_gap_days')::int = 28
     and (s ->> 'last_visit_at')::timestamptz = (today - 10 + time '10:00') at time zone at_,
    'Kemas: one visit, four weeks, the Fade with Rahman: ' || s::text;
  assert (s ->> 'next_free_at')::timestamptz = listed.next_free_at and listed.next_free_at is not null
     and (s ->> 'opens_today')::time = listed.opens_today and (s ->> 'closes_today')::time = listed.closes_today,
    'today''s hours and next free time as the shop list has them: ' || s::text;

  s := m -> 'shops' -> 1;
  select * into listed from find_shops() where id = '00000000-0000-0000-0000-00000000005a';
  assert s ->> 'barber_id' = '00000000-0000-0000-0000-0000000000a2' and s ->> 'barber_name' = 'Danial'
     and s ->> 'service_name' = 'Haircut' and (s ->> 'visits')::int = 3 and (s ->> 'usual_gap_days')::int = 21
     and (s ->> 'last_visit_at')::timestamptz = (today - 28 + time '09:00') at time zone at_
     and (s ->> 'is_live')::boolean and (s ->> 'next_free_at')::timestamptz is not distinct from listed.next_free_at,
    'Ali Cuts: every three weeks, the last with Danial, not counting the no-show or anything older than two years: '
      || s::text;

  s := m -> 'shops' -> 2;
  assert not (s ->> 'is_live')::boolean and s -> 'next_free_at' = 'null'::jsonb and s -> 'opens_today' = 'null'::jsonb
     and s ->> 'name' = 'Paused Cuts' and s ->> 'barber_name' = 'Mat' and (s ->> 'visits')::int = 1,
    'a paused shop is still his barber, with no free times: ' || s::text;

  assert (m ->> 'upcoming')::int = 2, 'two bookings to come: ' || m::text;
  assert m #>> '{next,shop_name}' = 'Kemas Cuts' and m #>> '{next,service_name}' = 'Fade'
     and m #>> '{next,barber_name}' = 'Rahman' and m #>> '{next,time_zone}' = at_
     and (m #>> '{next,starts_at}')::timestamptz = (today + 1 + time '10:00') at time zone at_
     and (m #>> '{next,id}')::uuid = (select id from bookings
                                      where customer_id = auth.uid() and status = 'confirmed' and starts_at > now()
                                      order by starts_at limit 1),
    'the soonest booking: ' || (m -> 'next')::text;
end $$;

-- Only the caller's own: Chong sees his one cut, someone with none sees
-- nothing, and guests can't ask.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare
  m jsonb := my_shops();
begin
  assert m -> 'next' = 'null'::jsonb and (m ->> 'upcoming')::int = 0, 'Chong has nothing booked: ' || m::text;
  assert jsonb_array_length(m -> 'shops') = 1 and m #>> '{shops,0,name}' = 'Ali Cuts'
     and (m #>> '{shops,0,visits}')::int = 1 and m #>> '{shops,0,barber_name}' = 'Ali',
    'only Chong''s own cut: ' || m::text;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  assert my_shops() = '{"next": null, "upcoming": 0, "shops": []}'::jsonb, 'no bookings, no cards: ' || my_shops()::text;
end $$;
reset role;
set role anon;
do $$ begin
  perform my_shops();
  raise exception 'guests must not call my_shops';
exception when insufficient_privilege then null;
end $$;
rollback;

-- Limits on what one customer can do ---------------------------------------
reset role;
delete from working_hours where barber_id = '00000000-0000-0000-0000-0000000000a2';
update working_hours set opens_at = '08:00', closes_at = '22:00';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
set role authenticated;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 2;
  t timestamptz;
  i int;
begin
  -- Too far ahead: no slots, and booking is refused.
  assert (select count(*) from available_slots('00000000-0000-0000-0000-0000000000e1',
          (now() at time zone 'Asia/Kuala_Lumpur')::date + 61)) = 0,
    'no slots beyond the booking horizon';

  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1',
      (d + time '09:00') at time zone 'Asia/Kuala_Lumpur', null, repeat('x', 281));
    raise exception 'over-long notes should be refused';
  exception when sqlstate '22001' then null;
  end;

  for i in 0..3 loop
    t := (d + time '09:00' + make_interval(hours => i)) at time zone 'Asia/Kuala_Lumpur';
    perform book_appointment('00000000-0000-0000-0000-0000000000e1', t);
  end loop;
  begin
    perform book_appointment('00000000-0000-0000-0000-0000000000e1',
      (d + time '15:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'a fifth upcoming booking at one shop should be refused';
  exception when sqlstate 'P0001' then null;
  end;
end $$;

-- What customers changed since the shop last looked --------------------------
-- Customers' own bookings, moves and cancellations show to the shop's owner;
-- the shop's own changes never do. Ali works 08:00-22:00 every day by now, and
-- everything is tomorrow or later, so it reads the same at any hour.
begin;
reset role;
delete from bookings;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
set role authenticated;

-- Ben books 09:00 and 11:00 tomorrow, then moves the second to 12:00; Chong books 10:00 and cancels it.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  b bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '09:00') at time zone 'Asia/Kuala_Lumpur');
  assert b.customer_change = 'booked' and b.customer_changed_at >= now(), 'booking online is the customer''s change';
  perform set_config('test.booked', b.id::text, false);
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '11:00') at time zone 'Asia/Kuala_Lumpur');
  perform set_config('test.moved_from', b.customer_changed_at::text, false);
  b := reschedule_booking(b.id, (d + time '12:00') at time zone 'Asia/Kuala_Lumpur');
  assert b.customer_change = 'moved' and b.customer_changed_at > current_setting('test.moved_from')::timestamptz,
    'a customer''s move is their change';
  perform set_config('test.moved', b.id::text, false);
  -- Two more: one the shop cancels below, and one Ben cancels that the shop takes back.
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '14:00') at time zone 'Asia/Kuala_Lumpur');
  perform set_config('test.shop_cancels', b.id::text, false);
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '16:00') at time zone 'Asia/Kuala_Lumpur');
  b := set_booking_status(b.id, 'cancelled');
  perform set_config('test.taken_back', b.id::text, false);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare
  b bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1',
    ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1 + time '10:00') at time zone 'Asia/Kuala_Lumpur');
  b := set_booking_status(b.id, 'cancelled');
  assert b.customer_change = 'cancelled', 'a customer''s cancel is their change';
  perform set_config('test.cancelled', b.id::text, false);
end $$;

-- The shop's own changes leave them as they were.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  before bookings;
  b bookings;
begin
  select * into before from bookings where id = current_setting('test.moved')::uuid;
  b := reschedule_booking(before.id, (d + time '12:30') at time zone 'Asia/Kuala_Lumpur');
  assert b.customer_change = 'moved' and b.customer_changed_at = before.customer_changed_at,
    'the shop moving a booking is not the customer''s change';
  b := set_booking_status(current_setting('test.shop_cancels')::uuid, 'cancelled');
  assert b.customer_change = 'booked', 'the shop cancelling is not the customer''s change';
  -- Ben cancelled one, and the shop took it back: it stands, so it is no news.
  b := set_booking_status(current_setting('test.taken_back')::uuid, 'confirmed');
  assert b.customer_change = 'cancelled' and b.status = 'confirmed', 'taking a cancel back is the shop''s change';
  b := add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '15:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Pak Abu');
  assert b.customer_change is null and b.customer_changed_at is null, 'a walk-in is the shop''s own';
  begin
    update bookings set customer_changed_at = null, customer_change = null where id = b.id;
    raise exception 'owners should not write the change columns';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Older news, written straight in: today's first half hour (it ends today,
-- so it counts whenever this runs), yesterday's last, and next week's
-- booked eight days ago.
reset role;
insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at, status,
                      customer_changed_at, customer_change)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1',
       '00000000-0000-0000-0000-0000000000c1', 'Haircut', 25, x.at, x.at + interval '30 minutes', 'confirmed',
       now() - f.ago, 'booked'
from (values (0, '00:00', interval '2 hours'), (-1, '23:00', interval '1 hour'), (7, '09:00', interval '8 days'))
       f(days, clock, ago),
     lateral (select ((now() at time zone 'Asia/Kuala_Lumpur')::date + f.days + f.clock::time)
                     at time zone 'Asia/Kuala_Lumpur' as at) x;
set role authenticated;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 1;
  r jsonb := shop_changes();
  c jsonb;
begin
  -- Chong's cancel came last, then Ben's move, his booking, and this morning's from two hours ago.
  assert (r ->> 'count')::int = 4, 'Ben''s booking and move, Chong''s cancel and this morning''s: ' || r::text;
  assert (r ->> 'since')::timestamptz = now() - interval '24 hours', 'a phone that never looked gets the last day';
  assert (select array_agg(e ->> 'change' order by i) from jsonb_array_elements(r -> 'changes') with ordinality a(e, i))
         = array['cancelled', 'moved', 'booked', 'booked'], 'newest first: ' || (r -> 'changes')::text;
  assert r -> 'changes' -> 0 ->> 'customer_name' = 'Chong'
     and r -> 'changes' -> 0 ->> 'booking_id' = current_setting('test.cancelled'), 'Chong''s cancel';
  assert (r ->> 'latest')::timestamptz = (r -> 'changes' -> 0 ->> 'changed_at')::timestamptz, 'latest is the newest change';
  c := r -> 'changes' -> 1;
  assert c ->> 'booking_id' = current_setting('test.moved') and c ->> 'customer_name' = 'Ben'
     and c ->> 'barber_name' = 'Ali' and c ->> 'barber_id' = '00000000-0000-0000-0000-0000000000a1'
     and c ->> 'service_name' = 'Haircut'
     and (c ->> 'starts_at')::timestamptz = (d + time '12:30') at time zone 'Asia/Kuala_Lumpur',
    'each change says who, what, with whom and when it is now: ' || c::text;
  assert r -> 'changes' -> 2 ->> 'booking_id' = current_setting('test.booked'), 'Ben''s booking';
  -- Chong's time is still free, so a walk-in can have it; nothing else freed a chair.
  assert (r -> 'changes' -> 0 ->> 'chair_free')::boolean, 'a cancelled time nobody has taken is free: ' || r::text;
  assert (select bool_and(not (e ->> 'chair_free')::boolean)
          from jsonb_array_elements(r -> 'changes') with ordinality a(e, i) where i > 1),
    'only a cancel frees a chair: ' || r::text;

  -- Once a phone has seen up to the newest, nothing is new; from an earlier change, what came after.
  r := shop_changes((r ->> 'latest')::timestamptz);
  assert (r ->> 'count')::int = 0 and r -> 'changes' = '[]' and r -> 'latest' = 'null', 'nothing new: ' || r::text;
  r := shop_changes((select customer_changed_at from bookings where id = current_setting('test.booked')::uuid));
  assert (r ->> 'count')::int = 2, 'what came after a change: ' || r::text;

  -- Never more than a week back, and a few at a time with the count for all.
  r := shop_changes(now() - interval '30 days');
  assert (r ->> 'since')::timestamptz = now() - interval '7 days' and (r ->> 'count')::int = 4,
    'a week at most: ' || r::text;
  r := shop_changes(null, 1);
  assert jsonb_array_length(r -> 'changes') = 1 and (r ->> 'count')::int = 4, 'one line, and the count for all';
  assert jsonb_array_length(shop_changes(null, 0) -> 'changes') = 0, 'just the count';

  -- Once the shop puts a walk-in in Chong's time, the chair is no longer free.
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '10:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Pak Long');
  r := shop_changes();
  assert (r ->> 'count')::int = 4 and r -> 'changes' -> 0 ->> 'change' = 'cancelled'
     and not (r -> 'changes' -> 0 ->> 'chair_free')::boolean, 'a taken time is not free: ' || r::text;
end $$;

-- A page is at most 20.
reset role;
insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at,
                      customer_changed_at, customer_change)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1',
       '00000000-0000-0000-0000-0000000000c2', 'Haircut', 25, x.at, x.at + interval '30 minutes',
       now() - k * interval '1 minute', 'booked'
from generate_series(1, 25) k,
     lateral (select ((now() at time zone 'Asia/Kuala_Lumpur')::date + 2 + time '08:00' + k * interval '30 minutes')
                     at time zone 'Asia/Kuala_Lumpur' as at) x;
set role authenticated;
do $$ begin
  assert jsonb_array_length(shop_changes(null, 1000) -> 'changes') = 20, 'capped at 20';
  assert (shop_changes(null, 1000) ->> 'count')::int = 29, 'the count is for all';
end $$;

-- Nobody else hears about them: another shop's owner, a customer, or a guest.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  assert (shop_changes() ->> 'count')::int = 0 and shop_changes() -> 'changes' = '[]', 'another shop''s owner gets nothing';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert (shop_changes() ->> 'count')::int = 0 and shop_changes() -> 'changes' = '[]', 'customers get nothing';
end $$;
reset role;
set role anon;
do $$ begin
  perform shop_changes();
  raise exception 'guests must not call shop_changes';
exception when insufficient_privilege then null;
end $$;
rollback;

-- Takings summary ----------------------------------------------------------
-- A finished week three weeks ago, the week before it, and a second shop
-- whose bookings must not show up.
begin;
reset role;
delete from bookings;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000005b', 'Rahman');
-- Two barbers since marked away.
insert into barbers (id, shop_id, name, is_active) values
  ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-00000000005a', 'Faiz', false),
  ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-00000000005a', 'Zul', false);
do $$
declare
  tz text := 'Asia/Kuala_Lumpur';
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date - 20;
  ali uuid := '00000000-0000-0000-0000-0000000000a1';
  danial uuid := '00000000-0000-0000-0000-0000000000a2';
  faiz uuid := '00000000-0000-0000-0000-0000000000a4';
  zul uuid := '00000000-0000-0000-0000-0000000000a5';
begin
  insert into bookings (shop_id, barber_id, guest_name, is_block, service_name, price, starts_at, ends_at, status)
  select coalesce(shop, '00000000-0000-0000-0000-00000000005a'), barber, case when block then null else 'Guest' end,
         block, name, price, (day + at) at time zone tz, (day + at) at time zone tz + interval '30 minutes',
         status::booking_status
  from (values
    -- This week: Haircut is 25 now, but one was booked at the old price of 18.
    (null::uuid, ali, d, time '10:00', 'Haircut', 25, 'completed', false),
    (null, ali, d, '11:00', 'Skin fade', 30, 'completed', false),
    (null, danial, d + 1, '10:00', 'Haircut', 25, 'no_show', false),
    (null, ali, d + 2, '10:00', 'Haircut', 25, 'cancelled', false),
    (null, danial, d + 2, '10:00', 'Haircut', 25, 'completed', false),
    (null, ali, d + 3, '13:00', 'Lunch', 50, 'confirmed', true),
    (null, danial, d + 4, '15:00', 'Haircut', 25, 'confirmed', false),
    (null, ali, d + 5, '10:00', 'Haircut', 18, 'completed', false),
    (null, ali, d + 6, '23:30', 'Haircut', 40, 'completed', false),
    -- Not this week: the day after, and another shop.
    (null, ali, d + 7, '00:00', 'Haircut', 99, 'completed', false),
    ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a9', d + 1, '10:00', 'Haircut', 500, 'completed', false),
    -- The week after, while Danial is away: Faiz's no-show and Zul's cancelled cut.
    (null, faiz, d + 9, '10:00', 'Haircut', 25, 'no_show', false),
    (null, zul, d + 9, '11:00', 'Haircut', 25, 'cancelled', false),
    -- The week before, and one from before that.
    (null, ali, d - 7, '10:00', 'Haircut', 25, 'completed', false),
    (null, ali, d - 3, '10:00', 'Skin fade', 30, 'no_show', false),
    (null, danial, d - 1, '23:45', 'Haircut', 20, 'completed', false),
    (null, ali, d - 1, '12:00', 'Haircut', 25, 'cancelled', false),
    (null, ali, d - 8, '10:00', 'Haircut', 1000, 'completed', false)
  ) v(shop, barber, day, at, name, price, status, block);
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date - 20;
  s jsonb := shop_summary(d, d + 6);
begin
  assert s -> 'totals' = '{"done": 5, "takings": 138, "no_shows": 1, "no_show_value": 25, "cancelled": 1,
                          "to_come": 0, "to_come_value": 0, "unmarked": 1, "unmarked_value": 25}'::jsonb,
    'totals should count this shop''s bookings at their booked price, without blocked time: ' || (s -> 'totals')::text;
  assert (s -> 'previous') - 'until' = jsonb_build_object(
      'from', d - 7, 'to', d - 1, 'done', 2, 'takings', 45, 'no_shows', 1, 'no_show_value', 30, 'cancelled', 1),
    'the week before should be counted the same way: ' || (s -> 'previous')::text;
  assert (s #>> '{previous,until}')::timestamptz = d::timestamp at time zone 'Asia/Kuala_Lumpur',
    'a finished week compares with the whole week before';
  assert jsonb_array_length(s -> 'days') = 7 and s #>> '{days,0,day}' = d::text and s #>> '{days,6,day}' = (d + 6)::text,
    'every day of the period should be there';
  assert (select array_agg((x ->> 'bookings')::int order by i) from jsonb_array_elements(s -> 'days') with ordinality a(x, i))
         = array[2, 1, 1, 0, 1, 1, 1], 'bookings by day leave out cancellations and blocks: ' || (s -> 'days')::text;
  assert s -> 'days' -> 6 = jsonb_build_object('day', d + 6, 'bookings', 1, 'done', 1, 'takings', 40),
    'a late booking on the last day is that day''s, by the shop''s clock';
  assert s -> 'hours' = '[{"hour": 10, "bookings": 4}, {"hour": 11, "bookings": 1}, {"hour": 15, "bookings": 1},
                         {"hour": 23, "bookings": 1}]'::jsonb, 'by start hour, shop time: ' || (s -> 'hours')::text;
  assert s -> 'barbers' = '[{"barber_id": "00000000-0000-0000-0000-0000000000a1", "name": "Ali", "bookings": 4, "done": 4,
                              "takings": 113, "no_shows": 0},
                             {"barber_id": "00000000-0000-0000-0000-0000000000a2", "name": "Danial", "bookings": 3, "done": 1,
                              "takings": 25, "no_shows": 1}]'::jsonb, 'by barber, most takings first: ' || (s -> 'barbers')::text;
  assert s -> 'services' = '[{"name": "Haircut", "done": 4, "takings": 108}, {"name": "Skin fade", "done": 1, "takings": 30}]'::jsonb,
    'services by how many were done: ' || (s -> 'services')::text;

  -- A barber with nothing booked is still there with nothing, so a week away
  -- shows. One since marked away shows only for a week they had bookings in.
  assert shop_summary(d + 7, d + 13) -> 'barbers' = '[
      {"barber_id": "00000000-0000-0000-0000-0000000000a1", "name": "Ali", "bookings": 1, "done": 1, "takings": 99, "no_shows": 0},
      {"barber_id": "00000000-0000-0000-0000-0000000000a2", "name": "Danial", "bookings": 0, "done": 0, "takings": 0, "no_shows": 0},
      {"barber_id": "00000000-0000-0000-0000-0000000000a4", "name": "Faiz", "bookings": 1, "done": 0, "takings": 0, "no_shows": 1}
    ]'::jsonb, 'every barber working here, and Faiz for his no-show: ' || (shop_summary(d + 7, d + 13) -> 'barbers')::text;

  -- A quiet week has nothing in the lists but the barbers, and zeros elsewhere.
  s := shop_summary(d - 50, d - 44);
  assert (s #>> '{totals,done}')::int = 0 and s -> 'hours' = '[]' and s -> 'services' = '[]'
     and jsonb_array_length(s -> 'days') = 7, 'an empty week';
  assert s -> 'barbers' = '[
      {"barber_id": "00000000-0000-0000-0000-0000000000a1", "name": "Ali", "bookings": 0, "done": 0, "takings": 0, "no_shows": 0},
      {"barber_id": "00000000-0000-0000-0000-0000000000a2", "name": "Danial", "bookings": 0, "done": 0, "takings": 0, "no_shows": 0}
    ]'::jsonb, 'the barbers working here, with nothing: ' || (s -> 'barbers')::text;

  -- The period before has the same length, except a whole month, which compares with the month before.
  assert shop_summary('2026-01-01', '2026-01-31') #>> '{previous,from}' = '2025-12-01', 'January compares with December';
  assert (select x ->> 'from' = '2026-02-01' and x ->> 'to' = '2026-02-28'
          from (select shop_summary('2026-03-01', '2026-03-31') -> 'previous' as x) y), 'March compares with February';
  assert shop_summary('2026-03-01', '2026-03-15') #>> '{previous,from}' = '2026-02-14', 'half a month: the 15 days before';
  assert shop_summary('2026-01-02', '2026-02-01') #>> '{previous,from}' = '2025-12-02', '31 days that aren''t a month';

  assert jsonb_array_length(shop_summary(d - 92, d) -> 'days') = 93, '93 days is the most';
  begin
    perform shop_summary(d - 93, d);
    raise exception '94 days should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Pick a period of up to 93 days.', 'unexpected message: ' || sqlerrm;
  end;
  begin
    perform shop_summary(d, d - 1);
    raise exception 'a period ending before it starts should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform shop_summary(null, d);
    raise exception 'a period without a start should be refused';
  exception when sqlstate '22023' then null;
  end;
end $$;

-- The other shop's owner only sees their own takings.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date - 20;
begin
  assert shop_summary(d, d + 6) #> '{totals,takings}' = '500', 'each owner gets their own shop';
end $$;

-- Customers have no shop, and guests can't ask.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform shop_summary(current_date - 6, current_date);
  raise exception 'customers should not get a summary';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'Set up your shop first.', 'unexpected message: ' || sqlerrm;
end $$;
reset role;
set role anon;
do $$ begin
  perform shop_summary(current_date - 6, current_date);
  raise exception 'guests must not call shop_summary';
exception when insufficient_privilege then null;
end $$;
rollback;

-- A week that is still running: bookings to come, one in the chair, one
-- over and not marked, and the week before counted only up to the same
-- point, so the comparison is fair whatever the time of day.
begin;
reset role;
delete from bookings;
do $$
declare
  ali uuid := '00000000-0000-0000-0000-0000000000a1';
  danial uuid := '00000000-0000-0000-0000-0000000000a2';
begin
  insert into bookings (shop_id, barber_id, guest_name, service_name, price, starts_at, ends_at, status)
  select '00000000-0000-0000-0000-00000000005a', barber, 'Guest', 'Haircut', price, at, at + interval '30 minutes',
         status::booking_status
  from (values
    (ali, now() + interval '2 hours', 25, 'confirmed'),
    (danial, now() - interval '10 minutes', 30, 'confirmed'),
    (ali, now() - interval '1 hour', 20, 'confirmed'),
    (danial, now() - interval '1 day', 18, 'completed'),
    -- The week before: an hour before this time of the week, and an hour after.
    (ali, now() - interval '7 days 1 hour', 25, 'completed'),
    (ali, now() - interval '7 days' + interval '1 hour', 30, 'completed')
  ) v(barber, at, price, status);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  s jsonb := shop_summary(today - 1, today + 5);
begin
  assert s -> 'totals' = '{"done": 1, "takings": 18, "no_shows": 0, "no_show_value": 0, "cancelled": 0,
                          "to_come": 2, "to_come_value": 55, "unmarked": 1, "unmarked_value": 20}'::jsonb,
    'to come includes the one in the chair; over and unmarked is counted apart: ' || (s -> 'totals')::text;
  assert (s #>> '{previous,until}')::timestamptz = now() - interval '7 days',
    'the week before is counted up to this time last week: ' || (s #>> '{previous,until}');
  assert s #> '{previous,done}' = '1' and s #> '{previous,takings}' = '25', 'only what was done by this time last week';
  -- A week that hasn't started yet has nothing before it to compare.
  assert (shop_summary(today + 7, today + 13) #>> '{previous,until}')::timestamptz
         < (today::timestamp at time zone 'Asia/Kuala_Lumpur'), 'a later week';
  assert shop_summary(today + 7, today + 13) #> '{previous,done}' = '0', 'nothing to compare before it starts';
end $$;
rollback;

-- Reviews ----------------------------------------------------------------------
-- Customers rate a cut once the shop has marked it done, for 14 days after
-- it started. Each shop's count and total follow every change, and the
-- owner replies. Ben's cuts are with Faiz and Zul, chairs added for this part.
begin;
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug, is_published) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts', true);
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-00000000005a', 'Faiz'),
  ('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-00000000005a', 'Zul'),
  ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-00000000005b', 'Rahman');
-- A surname, and spaces typed around the name.
update profiles set full_name = '  Ben   Lee ' where id = '00000000-0000-0000-0000-0000000000c1';
insert into bookings (id, shop_id, barber_id, customer_id, guest_name, service_name, price, starts_at, ends_at, status)
select x.id::uuid, x.shop::uuid, x.barber::uuid, x.customer::uuid, x.guest, 'Haircut', 25, x.at, x.at + interval '30 minutes',
       x.status::booking_status
from (values
  -- Ben: done two hours ago, done just inside 14 days, and just outside.
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '2 hours', 'completed'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '14 days' + interval '1 minute', 'completed'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a7',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '14 days', 'completed'),
  -- Past but never marked done, a no-show, and one still to come.
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '3 days', 'confirmed'),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '4 days', 'no_show'),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', null, now() + interval '1 day', 'confirmed'),
  -- Chong's cut, a walk-in's, Ben's at the other shop, and the owner's own at his.
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c2', null, now() - interval '5 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   null, 'Pak Abu', now() - interval '6 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a9',
   '00000000-0000-0000-0000-0000000000c1', null, now() - interval '1 day', 'completed'),
  ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000b1', null, now() - interval '7 days', 'completed')
) x(id, shop, barber, customer, guest, at, status);

-- The name a review shows: the name people go by, never a surname or their
-- father's name. src/lib/reviews.test.ts checks firstName with the same list.
do $$
declare
  c text[];
begin
  foreach c slice 1 in array array[
    ['Hakim', 'Hakim'],
    ['  Ben   Lee ', 'Ben'],
    [E'\tMohd. Ben bin Hassan', 'Ben'],
    ['MUHAMMAD Aiman', 'Aiman'],
    ['Muhammad', 'Muhammad'],
    ['Muhammad bin Abdullah', 'Muhammad'],
    ['Mohd bin Ali', 'Mohd'],
    ['Mohdzan Ali', 'Mohdzan'],
    ['Abdul Rahman bin Ismail', 'Abdul Rahman'],
    ['Muhammad Abd. Aziz', 'Abd. Aziz'],
    ['Nur Aisyah binti Ahmad', 'Nur'],
    ['Wan Faizal', 'Faizal'],
    ['Syed Ahmad bin Syed Ali', 'Ahmad'],
    ['Wan Abdul Rahman', 'Abdul Rahman'],
    ['Haji Mohd Ali b. Abu', 'Ali'],
    ['Dato'' Rahim', 'Rahim'],
    ['Wan', 'Wan'],
    ['Ravi a/l Kumar', 'Ravi'],
    ['Kavitha A/P Raju', 'Kavitha'],
    ['Tan Wei Jie', 'Wei Jie'],
    ['Dr Lim Kit Siang', 'Kit Siang'],
    ['Daniel Tan', 'Daniel'],
    ['Daniel Tan Wei Jie', 'Daniel'],
    -- No rule tells a given name from a surname here, so the form shows it.
    ['Wei Jie', 'Wei'],
    [repeat('x', 50), repeat('x', 40)],
    [E'\t', 'Customer'],
    [null, 'Customer']
  ] loop
    assert review_first_name(c[1]) = c[2], format('%L should show as %L, not %L', c[1], c[2], review_first_name(c[1]));
  end loop;
end $$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  ali uuid := '00000000-0000-0000-0000-00000000005a';
  kemas uuid := '00000000-0000-0000-0000-00000000005b';
  r reviews;
  b uuid;
  n int;
begin
  r := rate_booking('00000000-0000-0000-0000-0000000000f1', 5, E'  Great fade, very neat \n');
  assert r.rating = 5 and r.comment = 'Great fade, very neat' and r.first_name = 'Ben' and r.shop_id = ali
     and r.barber_id = '00000000-0000-0000-0000-0000000000a6' and r.customer_id = auth.uid()
     and r.reply is null and r.created_at = now(), 'a rating, with only the first name: ' || row(r.*)::text;
  assert (select rating_count = 1 and rating_sum = 5 from shops where id = ali), 'the shop counts it';

  -- The customer can change the name it shows, which then stays until they
  -- change it again. It is tidied and cut to 40 characters; a blank one is none.
  r := rate_booking('00000000-0000-0000-0000-0000000000f1', 5, null, E'  Benny \n Boy ');
  assert r.first_name = 'Benny Boy', 'a name of their own: ' || r.first_name;
  update profiles set full_name = 'Muhammad bin Abdullah' where id = auth.uid();
  assert (rate_booking('00000000-0000-0000-0000-0000000000f1', 5)).first_name = 'Benny Boy', 'kept on a change';
  assert (rate_booking('00000000-0000-0000-0000-0000000000f1', 5, null, '   ')).first_name = 'Benny Boy', 'blank is no change';
  assert (rate_booking('00000000-0000-0000-0000-0000000000f1', 5, null, repeat('Ben ', 15))).first_name
         = rtrim(left(repeat('Ben ', 15), 40)), 'at most 40 characters';
  assert (rate_booking('00000000-0000-0000-0000-0000000000f1', 5, null, 'Ben')).first_name = 'Ben', 'and back';
  update profiles set full_name = '  Ben   Lee ' where id = auth.uid();
  begin
    perform review_first_name('Ben');
    raise exception 'customers should not call review_first_name';
  exception when insufficient_privilege then null;
  end;

  -- Rating again inside the window changes the same review.
  r := rate_booking('00000000-0000-0000-0000-0000000000f1', 3, '   ');
  assert r.rating = 3 and r.comment is null, 'rating again changes it, and a blank comment is none';
  assert (select count(*) from reviews where booking_id = '00000000-0000-0000-0000-0000000000f1') = 1, 'still one review';
  assert (select rating_count = 1 and rating_sum = 3 from shops where id = ali), 'the total follows the change';
  r := rate_booking('00000000-0000-0000-0000-0000000000f2', 4, null, 'Ben L');
  assert (select rating_count = 2 and rating_sum = 7 from shops where id = ali), 'a minute inside 14 days still counts';
  assert r.first_name = 'Ben L', 'a new review takes the name given';
  r := rate_booking('00000000-0000-0000-0000-0000000000f9', 5, 'Kemas!');
  assert (select rating_count = 1 and rating_sum = 5 from shops where id = kemas)
     and (select rating_count = 2 from shops where id = ali), 'each shop counts its own';

  -- 280 characters fit; 281 don't, and nothing changes.
  r := rate_booking('00000000-0000-0000-0000-0000000000f2', 4, repeat('x', 280));
  assert length(r.comment) = 280, 'a comment of 280 characters';
  begin
    perform rate_booking('00000000-0000-0000-0000-0000000000f2', 2, repeat('x', 281));
    raise exception 'a comment over 280 characters should be refused';
  exception when sqlstate '22001' then
    assert sqlerrm = 'Please keep your comment under 280 characters.', 'unexpected message: ' || sqlerrm;
  end;
  assert (select rating from reviews where booking_id = '00000000-0000-0000-0000-0000000000f2') = 4, 'the review stays';

  -- Exactly 14 days after, never marked done, a no-show, and still to come.
  foreach b in array array['00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f4',
                           '00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f6']::uuid[] loop
    begin
      perform rate_booking(b, 5);
      raise exception 'booking % should not be rated', b;
    exception when sqlstate '42501' then
      assert sqlerrm = 'You can rate a cut once the shop marks it done, until 14 days after it.', 'unexpected message: ' || sqlerrm;
    end;
  end loop;
  foreach n in array array[0, 6, null]::int[] loop
    begin
      perform rate_booking('00000000-0000-0000-0000-0000000000f1', n);
      raise exception '% stars should be refused', n;
    exception when sqlstate '22023' then
      assert sqlerrm = 'Pick from 1 to 5 stars.', 'unexpected message: ' || sqlerrm;
    end;
  end loop;
  -- Someone else's cut, a walk-in's and one that doesn't exist.
  foreach b in array array['00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f8',
                           gen_random_uuid()]::uuid[] loop
    begin
      perform rate_booking(b, 5);
      raise exception 'booking % is not Ben''s to rate', b;
    exception when sqlstate 'P0002' then
      assert sqlerrm = 'Booking not found.', 'unexpected message: ' || sqlerrm;
    end;
  end loop;
  assert (select rating_count = 2 and rating_sum = 7 from shops where id = ali), 'refusals change no count';

  -- Reviews are only written through the functions.
  begin
    insert into reviews (booking_id, shop_id, barber_id, customer_id, rating, first_name)
    values ('00000000-0000-0000-0000-0000000000f3', ali, '00000000-0000-0000-0000-0000000000a6', auth.uid(), 5, 'Ben');
    raise exception 'reviews should not be inserted directly';
  exception when insufficient_privilege then null;
  end;
  begin
    update reviews set rating = 5;
    raise exception 'reviews should not be changed directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from reviews;
    raise exception 'reviews should not be deleted directly';
  exception when insufficient_privilege then null;
  end;

  -- My bookings has each cut's review, or none.
  assert (select e #>> '{review,rating}' = '3' and e #> '{review,comment}' = 'null'::jsonb
          from jsonb_array_elements(my_bookings() -> 'bookings') e where e ->> 'id' = '00000000-0000-0000-0000-0000000000f1'),
    'my_bookings should carry the review';
  assert (select e -> 'review' = 'null'::jsonb
          from jsonb_array_elements(my_bookings() -> 'bookings') e where e ->> 'id' = '00000000-0000-0000-0000-0000000000f4'),
    'a cut without a review has none';
end $$;

-- Chong rates his: 3, 4 and 4 make 3.7 on the shop list.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  perform rate_booking('00000000-0000-0000-0000-0000000000f7', 4, 'Quick and tidy');
  assert (select rating_count = 3 and rating_avg = 3.7 from find_shops() where id = '00000000-0000-0000-0000-00000000005a'),
    'the shop list has the count and the average to one decimal';
  assert (select rating_count = 1 and rating_avg = 5 from find_shops() where id = '00000000-0000-0000-0000-00000000005b'),
    'and each shop''s own';
end $$;

-- Owners reply to their own shop's reviews, can't touch the counts, and
-- can't rate their own shop.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare r reviews;
begin
  begin
    update shops set rating_count = 100;
    raise exception 'owners should not change their review count';
  exception when insufficient_privilege then null;
  end;
  begin
    update shops set rating_sum = 500;
    raise exception 'owners should not change their review total';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into shops (owner_id, name, slug, rating_count, rating_sum)
    values (auth.uid(), 'Five Stars', 'five-stars', 100, 500);
    raise exception 'a shop should not start with reviews';
  exception when insufficient_privilege then null;
  end;

  r := reply_to_review('00000000-0000-0000-0000-0000000000f7', E'  Thanks Chong, see you next month!\n');
  assert r.reply = 'Thanks Chong, see you next month!' and r.replied_at = now() and r.rating = 4,
    'the owner replies: ' || row(r.*)::text;
  assert (select rating_count = 3 and rating_sum = 11 from shops where id = '00000000-0000-0000-0000-00000000005a'),
    'a reply changes no count';
  r := reply_to_review('00000000-0000-0000-0000-0000000000f7', 'Thanks Chong!');
  assert r.reply = 'Thanks Chong!', 'the owner changes the reply';
  begin
    perform reply_to_review('00000000-0000-0000-0000-0000000000f7', repeat('x', 281));
    raise exception 'a reply over 280 characters should be refused';
  exception when sqlstate '22001' then
    assert sqlerrm = 'Please keep your reply under 280 characters.', 'unexpected message: ' || sqlerrm;
  end;
  r := reply_to_review('00000000-0000-0000-0000-0000000000f1', 'Sorry it wasn''t right, Ben.');
  r := reply_to_review('00000000-0000-0000-0000-0000000000f1', '  ');
  assert r.reply is null and r.replied_at is null, 'an empty reply takes it away';

  -- Not another shop's review, nor a cut nobody rated.
  foreach r.booking_id in array array['00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000f8']::uuid[] loop
    begin
      perform reply_to_review(r.booking_id, 'Thanks!');
      raise exception 'the owner should not reply to %', r.booking_id;
    exception when sqlstate 'P0002' then
      assert sqlerrm = 'Review not found.', 'unexpected message: ' || sqlerrm;
    end;
  end loop;
  begin
    perform rate_booking('00000000-0000-0000-0000-0000000000fa', 5, 'Best in town');
    raise exception 'an owner should not rate their own shop';
  exception when sqlstate '42501' then
    assert sqlerrm = 'You can''t rate your own shop.', 'unexpected message: ' || sqlerrm;
  end;
end $$;

-- The customer can't reply, nor can a guest rate or reply.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform reply_to_review('00000000-0000-0000-0000-0000000000f1', 'Thanks to me');
  raise exception 'customers should not reply';
exception when sqlstate 'P0002' then null;
end $$;
-- A guest's request carries no account.
set request.jwt.claim.sub = '';
set role anon;
do $$ begin
  perform rate_booking('00000000-0000-0000-0000-0000000000f1', 5);
  raise exception 'guests must not call rate_booking';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform reply_to_review('00000000-0000-0000-0000-0000000000f1', 'Hi');
  raise exception 'guests must not call reply_to_review';
exception when insufficient_privilege then null;
end $$;

-- Anyone reads a live shop's reviews, but not whose account wrote them.
do $$ begin
  assert (select count(*) from reviews) = 4, 'guests read live shops'' reviews';
  assert (select array_agg(first_name order by first_name) from reviews where shop_id = '00000000-0000-0000-0000-00000000005a')
         = array['Ben', 'Ben L', 'Chong'], 'with the name each shows only';
  assert (select reply from reviews where booking_id = '00000000-0000-0000-0000-0000000000f7') = 'Thanks Chong!',
    'and the shop''s reply';
  begin
    perform customer_id from reviews;
    raise exception 'guests should not see who wrote a review';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A paused shop's reviews are hidden, except from its owner and from the
-- reviewer, who still sees their own.
reset role;
update shops set is_published = false where id = '00000000-0000-0000-0000-00000000005b';
set request.jwt.claim.sub = '';
set role anon;
do $$ begin
  assert (select count(*) from reviews where shop_id = '00000000-0000-0000-0000-00000000005b') = 0, 'hidden from guests';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  assert (select count(*) from reviews) = 3, 'other customers see only the live shop''s';
  begin
    perform customer_id from reviews;
    raise exception 'customers should not see who wrote a review either';
  exception when insufficient_privilege then null;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert (select count(*) from reviews where shop_id = '00000000-0000-0000-0000-00000000005b') = 1, 'the reviewer sees their own';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  assert (select count(*) from reviews where shop_id = '00000000-0000-0000-0000-00000000005b') = 1,
    'the owner still sees their paused shop''s';
end $$;

-- A customer who deletes their account takes their reviews with them, and
-- an owner their shop's.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert (select rating_count = 2 and rating_sum = 7 from shops where id = '00000000-0000-0000-0000-00000000005a'),
    'a deleted customer''s review no longer counts';
  assert not exists (select 1 from reviews where booking_id = '00000000-0000-0000-0000-0000000000f7'), 'and is gone';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert not exists (select 1 from reviews where shop_id = '00000000-0000-0000-0000-00000000005b'), 'the shop''s reviews go with it';
  assert (select count(*) from reviews) = 2, 'and only those';
end $$;
rollback;

-- Each barber's line and stars --------------------------------------------------
-- The owner writes a short line about each barber. Each barber's review count
-- and total follow every review of their cuts, as the shop's do: when one is
-- written, changed or removed, and when a cut changes barber before or after
-- it is rated. Faiz and Zul are chairs added for this part.
begin;
reset role;
update shops set is_published = true, trial_ends_at = now() + interval '30 days'
where id = '00000000-0000-0000-0000-00000000005a';
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-00000000005a', 'Faiz'),
  ('00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-00000000005a', 'Zul');
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select b, d, '09:00', '12:00'
from unnest(array['00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-0000000000a7']::uuid[]) b,
     generate_series(0, 6) d;
insert into bookings (id, shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at, status)
select x.id::uuid, '00000000-0000-0000-0000-00000000005a', x.barber::uuid, '00000000-0000-0000-0000-0000000000e1',
       x.customer::uuid, 'Haircut', 25, x.at, x.at + interval '30 minutes', x.status::booking_status
from (values
  -- Ben's two cuts with Faiz and one with Zul, and Chong's with Faiz, all done.
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '2 hours', 'completed'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '3 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a7',
   '00000000-0000-0000-0000-0000000000c1', now() - interval '4 days', 'completed'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c2', now() - interval '5 days', 'completed'),
  -- Chong's next cut, with Faiz tomorrow at 10:00.
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a6',
   '00000000-0000-0000-0000-0000000000c2',
   ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1 + time '10:00') at time zone 'Asia/Kuala_Lumpur', 'confirmed')
) x(id, barber, customer, at, status);

-- One short line of plain text, written by the owner. The counts are the database's.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  faiz uuid := '00000000-0000-0000-0000-0000000000a6';
  bad text;
begin
  assert (select about is null and rating_count = 0 and rating_sum = 0 from barbers where id = faiz),
    'a new barber has no line and no reviews';
  update barbers set about = repeat('x', 60) where id = faiz;
  assert (select length(about) from barbers where id = faiz) = 60, '60 characters fit';
  foreach bad in array array[repeat('x', 61), '', '   ', E'Fades\nand beards', E'Kids\tcuts'] loop
    begin
      update barbers set about = bad where id = faiz;
      raise exception 'the line % should be refused', bad;
    exception when check_violation then null;
    end;
  end loop;
  update barbers set about = 'Fades and skin fades, 8 years' where id = faiz;
  assert (select about from barbers where id = faiz) = 'Fades and skin fades, 8 years', 'the owner writes a line';
  -- A barber can start with one, and lose it again.
  insert into barbers (id, shop_id, name, about)
  values ('00000000-0000-0000-0000-0000000000a8', shop, 'Amin', 'Kids'' cuts, patient with first-timers');
  update barbers set about = null where id = '00000000-0000-0000-0000-0000000000a8';
  assert (select about is null from barbers where id = '00000000-0000-0000-0000-0000000000a8'), 'none is fine';

  begin
    update barbers set rating_count = 100 where id = faiz;
    raise exception 'owners should not change a barber''s review count';
  exception when insufficient_privilege then null;
  end;
  begin
    update barbers set rating_sum = 500 where id = faiz;
    raise exception 'owners should not change a barber''s review total';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into barbers (shop_id, name, rating_count, rating_sum) values (shop, 'Five Stars', 100, 500);
    raise exception 'a barber should not start with reviews';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Ratings count for the barber who did the cut.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  faiz uuid := '00000000-0000-0000-0000-0000000000a6';
  zul uuid := '00000000-0000-0000-0000-0000000000a7';
begin
  perform rate_booking('00000000-0000-0000-0000-0000000000f1', 5);
  perform rate_booking('00000000-0000-0000-0000-0000000000f2', 4, 'Neat');
  perform rate_booking('00000000-0000-0000-0000-0000000000f3', 2);
  assert (select (rating_count, rating_sum) = (2, 9) from barbers where id = faiz), 'Faiz has two';
  assert (select (rating_count, rating_sum) = (1, 2) from barbers where id = zul), 'Zul has one';
  assert (select (rating_count, rating_sum) = (0, 0) from barbers where id = '00000000-0000-0000-0000-0000000000a1'),
    'and nobody else';
  -- Changing a rating changes the total, not the count; a comment or name alone changes neither.
  perform rate_booking('00000000-0000-0000-0000-0000000000f2', 2);
  assert (select (rating_count, rating_sum) = (2, 7) from barbers where id = faiz), 'the total follows the change';
  perform rate_booking('00000000-0000-0000-0000-0000000000f2', 2, 'A bit rushed', 'Ben L');
  assert (select (rating_count, rating_sum) = (2, 7) from barbers where id = faiz), 'a comment changes no count';
end $$;

-- The owner's reply changes no count.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform reply_to_review('00000000-0000-0000-0000-0000000000f3', 'Sorry, Ben. Come back and Zul will put it right.');
  assert (select (rating_count, rating_sum) = (1, 2) from barbers where id = '00000000-0000-0000-0000-0000000000a7'),
    'a reply changes no count';
end $$;

-- Chong moves his next cut from Faiz to Zul, has it, and rates it: it counts for Zul.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare b bookings;
begin
  b := reschedule_booking('00000000-0000-0000-0000-0000000000f5',
    ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1 + time '10:30') at time zone 'Asia/Kuala_Lumpur',
    '00000000-0000-0000-0000-0000000000a7');
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a7', 'moved to Zul';
end $$;
reset role;
update bookings set starts_at = now() - interval '1 day', ends_at = now() - interval '1 day' + interval '30 minutes',
                    status = 'completed'
where id = '00000000-0000-0000-0000-0000000000f5';
set role authenticated;
do $$
declare r reviews;
begin
  r := rate_booking('00000000-0000-0000-0000-0000000000f5', 5);
  assert r.barber_id = '00000000-0000-0000-0000-0000000000a7', 'the review is of the cut with Zul';
  perform rate_booking('00000000-0000-0000-0000-0000000000f4', 3);
  assert (select (rating_count, rating_sum) = (2, 7) from barbers where id = '00000000-0000-0000-0000-0000000000a7'),
    'Zul counts the cut he did';
  assert (select (rating_count, rating_sum) = (3, 10) from barbers where id = '00000000-0000-0000-0000-0000000000a6'),
    'and Faiz only his own';
end $$;

-- Anyone reads each barber's line and stars, and one barber's reviews, but
-- still not who wrote them.
set request.jwt.claim.sub = '';
set role anon;
do $$ begin
  assert (select about = 'Fades and skin fades, 8 years' and rating_count = 3 and rating_sum = 10
          from barbers where id = '00000000-0000-0000-0000-0000000000a6'), 'guests see Faiz''s line and stars';
  assert (select array_agg(booking_id order by created_at desc, booking_id) from reviews
          where shop_id = '00000000-0000-0000-0000-00000000005a' and barber_id = '00000000-0000-0000-0000-0000000000a7')
         = array['00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5']::uuid[],
    'Zul''s reviews alone';
  begin
    perform customer_id from reviews where barber_id = '00000000-0000-0000-0000-0000000000a7';
    raise exception 'guests should not see who wrote a barber''s review';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A rated cut put right to the other barber takes its review along.
reset role;
update bookings set barber_id = '00000000-0000-0000-0000-0000000000a7' where id = '00000000-0000-0000-0000-0000000000f1';
do $$ begin
  assert (select barber_id from reviews where booking_id = '00000000-0000-0000-0000-0000000000f1')
         = '00000000-0000-0000-0000-0000000000a7', 'the review follows its cut';
  assert (select (rating_count, rating_sum) = (2, 5) from barbers where id = '00000000-0000-0000-0000-0000000000a6')
     and (select (rating_count, rating_sum) = (3, 12) from barbers where id = '00000000-0000-0000-0000-0000000000a7'),
    'from Faiz''s stars to Zul''s';
end $$;

-- Ben deletes his account: his reviews no longer count for anyone.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert (select (rating_count, rating_sum) = (1, 3) from barbers where id = '00000000-0000-0000-0000-0000000000a6')
     and (select (rating_count, rating_sum) = (1, 5) from barbers where id = '00000000-0000-0000-0000-0000000000a7'),
    'only Chong''s reviews are left';
  -- However they got there, every barber's figures add up to their reviews.
  assert not exists (
    select 1 from barbers b
    where (b.rating_count, b.rating_sum)
          <> (select count(*)::int, coalesce(sum(r.rating), 0)::int from reviews r where r.barber_id = b.id)
  ), 'each barber''s count and total match their reviews';
  -- A barber with reviews stays, like one with bookings.
  begin
    delete from barbers where id = '00000000-0000-0000-0000-0000000000a7';
    raise exception 'a barber with reviews should not be deleted';
  exception when foreign_key_violation then null;
  end;
end $$;
rollback;

-- Near me ------------------------------------------------------------------------
-- Owners set where their shop is. Given the customer's position, the shop
-- list goes nearest first with each shop's distance, shops without a
-- location after the rest by name, in pages that never overlap.
begin;
reset role;
do $$ begin
  assert abs(km_between(0, 0, 0, 1) - 111.195) < 0.001, 'a degree along the equator is 111.195 km';
  assert km_between(2.9833, 101.7667, 2.9833, 101.7667) = 0, 'no distance to itself';
  assert abs(km_between(0, 0, 0, 180) - 20015.114) < 0.01, 'half way round the world, without rounding past it';
  assert abs(km_between(2.9833, 101.7667, 2.9925, 101.7884) - km_between(2.9925, 101.7884, 2.9833, 101.7667)) < 1e-9,
    'the same either way';
  assert km_between(2.9833, 101.7667, null, null) is null, 'no distance to a shop without a location';
end $$;
update shops set is_published = true, trial_ends_at = now() + interval '30 days'
where id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}'),
  ('00000000-0000-0000-0000-0000000000b3', 'owner3@test', '{"role":"barber","full_name":"Irfan"}'),
  ('00000000-0000-0000-0000-0000000000b4', 'owner4@test', '{"role":"barber","full_name":"Wei Ming"}'),
  ('00000000-0000-0000-0000-0000000000b5', 'owner5@test', '{"role":"barber","full_name":"Zaki"}'),
  ('00000000-0000-0000-0000-0000000000b6', 'owner6@test', '{"role":"barber","full_name":"Amin"}'),
  ('00000000-0000-0000-0000-0000000000b7', 'owner7@test', '{"role":"barber","full_name":"Mat"}');
insert into shops (id, owner_id, name, slug, area, latitude, longitude, is_published) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts',
   'Kajang', 2.9925, 101.7884, true),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000b3', 'Fade Cuts', 'fade-cuts',
   'Saujana Impian', 2.9822, 101.8045, true),
  -- Next door to Kemas, so just as far: after it by name.
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000b4', 'Twin Cuts', 'twin-cuts',
   'Kajang', 2.9925, 101.7884, true),
  ('00000000-0000-0000-0000-00000000005e', '00000000-0000-0000-0000-0000000000b5', 'Bangi Cuts', 'bangi-cuts',
   'Bangi', null, null, true),
  ('00000000-0000-0000-0000-00000000005f', '00000000-0000-0000-0000-0000000000b6', 'Alpha Cuts', 'alpha-cuts',
   'Kajang', null, null, true);
set role authenticated;

-- A new shop can say where it is from the start; this one isn't live yet.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b7';
insert into shops (owner_id, name, slug, latitude, longitude)
values ('00000000-0000-0000-0000-0000000000b7', 'Hidden Cuts', 'hidden-cuts', 2.9833, 101.7667);

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  begin
    update shops set latitude = 2.9846;
    raise exception 'half a location should be refused';
  exception when check_violation then null;
  end;
  begin
    update shops set latitude = 91, longitude = 101.7712;
    raise exception 'a latitude off the map should be refused';
  exception when check_violation then null;
  end;
  begin
    update shops set latitude = 2.9846, longitude = -181;
    raise exception 'a longitude off the map should be refused';
  exception when check_violation then null;
  end;
  begin
    update shops set latitude = 'NaN', longitude = 'NaN';
    raise exception 'not a number should be refused';
  exception when check_violation then null;
  end;
  update shops set latitude = 2.9846, longitude = 101.7712;
  assert (select latitude = 2.9846 and longitude = 101.7712 from shops where id = '00000000-0000-0000-0000-00000000005a'),
    'the owner sets where the shop is';
  -- Another shop's location is not theirs to move.
  update shops set latitude = 0, longitude = 0 where id = '00000000-0000-0000-0000-00000000005b';
  reset role;
  assert (select latitude = 2.9925 from shops where id = '00000000-0000-0000-0000-00000000005b'),
    'an owner can''t move another shop';
  set role authenticated;
  update shops set latitude = null, longitude = null;
  assert (select latitude is null from shops where id = '00000000-0000-0000-0000-00000000005a'), 'and can take it away';
  update shops set latitude = 2.9846, longitude = 101.7712;
end $$;

-- Ben is in Sungai Chua.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  lat constant double precision := 2.9833;
  lng constant double precision := 101.7667;
  nearest constant text[] := array['Ali Cuts', 'Kemas Cuts', 'Twin Cuts', 'Fade Cuts', 'Alpha Cuts', 'Bangi Cuts'];
  by_name constant text[] := array['Ali Cuts', 'Alpha Cuts', 'Bangi Cuts', 'Fade Cuts', 'Kemas Cuts', 'Twin Cuts'];
  paged text[] := '{}';
  ali record;
  b jsonb;
begin
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, null, 50, 0, lat, lng) with ordinality f)
         = nearest, 'nearest first, then the shops without a location by name';
  select * into ali from find_shops(null, null, 1, 0, lat, lng);
  assert ali.name = 'Ali Cuts' and ali.distance_km between 0.5 and 0.55, 'Ali Cuts is about 500 m away: ' || ali.distance_km;
  assert (ali.latitude, ali.longitude) = (select s.latitude, s.longitude from shops s where s.name = 'Ali Cuts'),
    'with where the shop is, for Directions before its page loads';
  assert (select count(distinct distance_km) = 1 and min(distance_km) between 2.6 and 2.65
          from find_shops(null, null, 50, 0, lat, lng) where name in ('Kemas Cuts', 'Twin Cuts')),
    'next door is just as far';
  assert (select bool_and(distance_km is null) from find_shops(null, null, 50, 0, lat, lng)
          where name in ('Alpha Cuts', 'Bangi Cuts')), 'no distance without a location';

  -- A page at a time, every shop once.
  for i in 0..5 loop
    paged := paged || (select array_agg(name) from find_shops(null, null, 1, i, lat, lng));
  end loop;
  assert paged = nearest, 'one at a time comes out the same: ' || paged::text;
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, null, 4, 4, lat, lng) with ordinality f)
         = array['Alpha Cuts', 'Bangi Cuts'], 'the second page of four';

  -- Without a whole position on the map, by name as before.
  assert (select array_agg(f.name order by f.ordinality) from find_shops() with ordinality f) = by_name, 'by name';
  assert (select bool_and(distance_km is null) from find_shops()), 'no distances without a position';
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, null, 50, 0, lat, null) with ordinality f)
         = by_name, 'half a position is left out';
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, null, 50, 0, 95, lng) with ordinality f)
         = by_name and (select bool_and(distance_km is null) from find_shops(null, null, 50, 0, 95, lng)),
    'a position off the map is left out';

  -- Search and areas still filter, nearest first.
  assert (select array_agg(f.name order by f.ordinality) from find_shops('kajang', null, 50, 0, lat, lng) with ordinality f)
         = array['Ali Cuts', 'Kemas Cuts', 'Twin Cuts', 'Alpha Cuts'], 'search, nearest first';
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, 'SAUJANA IMPIAN', 50, 0, lat, lng) with ordinality f)
         = array['Fade Cuts'], 'an area, with its distance';
  assert (select count(*) from find_shops(null, null, 50, 0, 2.9833, 101.7667) where name = 'Hidden Cuts') = 0,
    'a shop that isn''t live is never listed, however near';

  -- My bookings has the location too, for Directions.
  b := (select e from jsonb_array_elements(my_bookings() -> 'bookings') e where e ->> 'shop_id' = '00000000-0000-0000-0000-00000000005a' limit 1);
  assert (b -> 'shops' ->> 'latitude')::float8 = 2.9846 and (b -> 'shops' ->> 'longitude')::float8 = 101.7712,
    'my_bookings says where the shop is: ' || coalesce(b::text, 'no booking');
end $$;

set role anon;
do $$ begin
  assert (select name from find_shops(null, null, 1, 0, 2.9833, 101.7667)) = 'Ali Cuts', 'guests can look near them too';
  perform km_between(0, 0, 0, 1);
  raise exception 'guests must not call km_between';
exception when insufficient_privilege then null;
end $$;
set role authenticated;
do $$ begin
  perform km_between(0, 0, 0, 1);
  raise exception 'only find_shops should call km_between';
exception when insufficient_privilege then null;
end $$;

-- find_shops and my_shops ask for a whole page's hours and next free times
-- at once: that comes out as asking for each shop on its own. A shop that
-- isn't live is left out, except for its owner.
reset role;
do $$
declare
  kemas constant uuid := '00000000-0000-0000-0000-00000000005b';
  hidden uuid := (select id from shops where slug = 'hidden-cuts');
  ids uuid[] := array(select id from shops order by id);
  each_hours text[];
  each_free text[];
begin
  -- Kemas Cuts and Hidden Cuts get a barber, hours and a service, on other clocks.
  insert into barbers (id, shop_id, name) values
    ('00000000-0000-0000-0000-00000000009a', kemas, 'Rahman'),
    ('00000000-0000-0000-0000-00000000009b', hidden, 'Mat');
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  select b, d, '10:00', '22:00'
  from unnest(array['00000000-0000-0000-0000-00000000009a', '00000000-0000-0000-0000-00000000009b']::uuid[]) b,
       generate_series(0, 6) d;
  insert into services (shop_id, name, duration_min, price) values (kemas, 'Haircut', 45, 20), (hidden, 'Haircut', 30, 15);
  update shops set time_zone = 'Pacific/Kiritimati' where id = kemas;
  update shops set time_zone = 'America/Los_Angeles' where id = hidden;

  -- As a customer.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
  each_hours := array(select row(i, h.opens_today, h.closes_today)::text
                      from unnest(ids) i, lateral shop_hours_today(i) h where i <> hidden order by i);
  each_free := array(select f::text from unnest(ids) i, lateral shops_next_free(array[i]) f order by i);
  assert array(select h::text from shops_hours_today(ids) h order by h.shop_id) = each_hours,
    'hours today for several shops at once, as for each on its own';
  assert array(select f::text from shops_next_free(ids) f order by f.shop_id) = each_free,
    'next free times for several shops at once, as for each on its own';
  assert (select count(*) from shops_next_free(ids) where shop_id in ('00000000-0000-0000-0000-00000000005a', kemas)) = 2,
    'both shops with someone in have a next free time';
  assert not exists (select 1 from shops_hours_today(ids) where shop_id = hidden)
         and not exists (select 1 from shops_next_free(ids) where shop_id = hidden),
    'a shop that isn''t live is left out';
  assert (select opens_today is null from shop_hours_today(hidden)), 'one that isn''t live has no hours';

  -- As Hidden Cuts' owner, it's there.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b7', true);
  each_hours := array(select row(i, h.opens_today, h.closes_today)::text
                      from unnest(ids) i, lateral shop_hours_today(i) h order by i);
  each_free := array(select f::text from unnest(ids) i, lateral shops_next_free(array[i]) f order by i);
  assert array(select h::text from shops_hours_today(ids) h order by h.shop_id) = each_hours,
    'the owner''s hours today, several at once as each on its own';
  assert array(select f::text from shops_next_free(ids) f order by f.shop_id) = each_free,
    'the owner''s next free times, several at once as each on its own';
  assert (select opens_today = '10:00' from shops_hours_today(array[hidden]))
         and exists (select 1 from shops_next_free(array[hidden])),
    'the owner sees their own shop''s hours and next free time before it is live';
end $$;

-- The shop list picks a page straight off the name index when there is
-- nothing to filter by, and looks at every shop when there is: both come out
-- the same. Names that differ only in case sort together, and the id
-- settles a tie, so pages never overlap.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  by_name constant text[] := array['Ali Cuts', 'Alpha Cuts', 'bangi cuts', 'Fade Cuts', 'Kemas Cuts', 'KEMAS CUTS'];
  plain text[] := '{}';
  filtered text[] := '{}';
begin
  update shops set name = 'bangi cuts' where id = '00000000-0000-0000-0000-00000000005e';
  update shops set name = 'KEMAS CUTS' where id = '00000000-0000-0000-0000-00000000005d';
  assert (select array_agg(f::text order by f.ordinality) from find_shops() with ordinality f)
         = (select array_agg(f::text order by f.ordinality) from find_shops('cuts') with ordinality f),
    'with and without a filter that keeps every shop, the same rows';
  assert (select array_agg(f.name order by f.ordinality) from find_shops() with ordinality f) = by_name,
    'by name, whatever the case, then by id';
  for i in 0..5 loop
    plain := plain || (select array_agg(name) from find_shops(null, null, 1, i));
    filtered := filtered || (select array_agg(name) from find_shops('CUTS', null, 1, i));
  end loop;
  assert plain = by_name and filtered = by_name, 'one at a time, every shop once: ' || plain::text || filtered::text;
  assert (select array_agg(f.name order by f.ordinality) from find_shops(null, null, 4, 4) with ordinality f)
         = array['Kemas Cuts', 'KEMAS CUTS'], 'the second page of four';

  -- Areas: spellings that differ only in case are one area, under the
  -- spelling most of its shops use, or on a tie the first in order, as
  -- mode() picks it.
  update shops set area = 'Kajang' where id in ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-00000000005b');
  update shops set area = 'KAJANG' where id = '00000000-0000-0000-0000-00000000005d';
  update shops set area = 'kajang' where id = '00000000-0000-0000-0000-00000000005f';
  assert (select array_agg(row(a.area, a.shops)::text order by a.ordinality) from shop_areas() with ordinality a)
         = array['(Kajang,4)', '(Bangi,1)', '("Saujana Impian",1)'], 'areas: the most used spelling';
  update shops set area = 'KAJANG' where id = '00000000-0000-0000-0000-00000000005f';
  assert (select area from shop_areas() where lower(area) = 'kajang') = (select min(x) from unnest(array['Kajang', 'KAJANG']) x),
    'areas: on a tie, the first spelling in order';
  assert (select array_agg(row(a.area, a.shops)::text order by a.ordinality) from shop_areas() with ordinality a)
         = (select array_agg(row(x.area, x.n)::text order by x.n desc, x.k)
            from (select lower(s.area) as k, mode() within group (order by s.area) as area, count(*)::int as n
                  from shops s where shop_is_live(s) group by lower(s.area)) x),
    'areas as mode() would have them';
end $$;
rollback;

-- Signed up as a barber by mistake --------------------------------------------
-- Before making a shop, a barber account can turn into a customer one. An
-- owner can't, or their shop would be left without anyone to run it.
begin;
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b9', 'oops@test', '{"role":"barber","full_name":"Oops"}');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b9';
do $$ begin
  perform become_customer();
  assert (select role from profiles where id = auth.uid()) = 'customer', 'a barber with no shop becomes a customer';
  begin
    insert into shops (owner_id, name, slug) values (auth.uid(), 'Oops Cuts', 'oops-cuts');
    raise exception 'a customer should not be able to create a shop';
  exception when insufficient_privilege then null;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform become_customer();
  raise exception 'an owner should stay a barber';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'You have a shop, so this account stays a barber account.', sqlerrm;
end $$;
reset role;
set role anon;
do $$ begin
  perform become_customer();
  raise exception 'guests must not call become_customer';
exception when insufficient_privilege then null;
end $$;
rollback;

-- Getting a new shop ready ------------------------------------------------------
-- A new shop starts hidden and goes live only once customers have a service
-- to pick and a barber with working hours. shop_setup says what is there,
-- to the owner only.
begin;
reset role;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b8', 'owner8@test', '{"role":"barber","full_name":"Hafiz"}'),
  ('00000000-0000-0000-0000-0000000000ba', 'owner10@test', '{"role":"barber","full_name":"Zaki"}');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b8';
do $$ begin
  assert shop_setup() is null, 'no shop, nothing to say';
  insert into shops (owner_id, name, slug, is_published) values (auth.uid(), 'Live At Once', 'live-at-once', true);
  raise exception 'a shop should not be created already live';
exception when insufficient_privilege then null;
end $$;
insert into shops (owner_id, name, slug) values ('00000000-0000-0000-0000-0000000000b8', 'Hafiz Cuts', 'hafiz-cuts');

do $$
declare
  shop uuid := (select id from shops where slug = 'hafiz-cuts');
begin
  assert shop_setup() = '{"services": 0, "barbers": []}'::jsonb, 'a new shop has nothing yet: ' || shop_setup()::text;
  begin
    update shops set is_published = true where id = shop;
    raise exception 'a shop with nothing to book should not go live';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Add a service before you go live, so customers have something to book.', sqlerrm;
  end;

  -- A hidden service doesn't count, a shown one does.
  insert into services (shop_id, name, duration_min, price, is_active) values (shop, 'Old menu', 30, 15, false);
  begin
    update shops set is_published = true where id = shop;
    raise exception 'a hidden service is nothing to book';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Add a service before you go live, so customers have something to book.', sqlerrm;
  end;
  insert into services (shop_id, name, duration_min, price) values (shop, 'Haircut', 30, 20);
  assert (shop_setup() ->> 'services')::int = 1, 'only services customers can book count';

  -- The first chair, with no hours yet; one away with hours doesn't count either.
  insert into barbers (id, shop_id, name, sort_order) values
    ('00000000-0000-0000-0000-0000000000b0', shop, 'Hafiz', 0),
    ('00000000-0000-0000-0000-0000000000bb', shop, 'Away Ali', 1);
  update barbers set is_active = false where id = '00000000-0000-0000-0000-0000000000bb';
  insert into working_hours (barber_id, weekday, opens_at, closes_at)
  values ('00000000-0000-0000-0000-0000000000bb', 1, '10:00', '20:00');
  assert shop_setup() -> 'barbers' = '[{"id": "00000000-0000-0000-0000-0000000000b0", "name": "Hafiz", "has_hours": false}]'::jsonb,
    'active barbers only, saying who has no hours: ' || shop_setup()::text;
  begin
    update shops set is_published = true where id = shop;
    raise exception 'a shop with no working hours should not go live';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Add a barber with working hours before you go live, so customers can pick a time.', sqlerrm;
  end;
  assert (select not is_published and published_at is null from shops where id = shop), 'still hidden';

  -- One day a week is enough.
  perform set_barber_hours('00000000-0000-0000-0000-0000000000b0',
                           '[{"weekday": 6, "opens_at": "10:00", "closes_at": "14:00"}]'::jsonb);
  assert (shop_setup() -> 'barbers' -> 0 ->> 'has_hours')::boolean, 'hours are noted';
  update shops set is_published = true where id = shop;
  assert (select is_published and published_at is not null from shops where id = shop), 'live now';

  -- Emptying the menu later is the owner's call, but going back on after a pause checks again.
  update services set is_active = false where shop_id = shop;
  assert (select is_published from shops where id = shop), 'a live shop stays live';
  update shops set name = 'Hafiz Cuts Kajang' where id = shop;
  update shops set is_published = false where id = shop;
  begin
    update shops set is_published = true where id = shop;
    raise exception 'a paused shop with nothing to book should not come back on';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Add a service before you go live, so customers have something to book.', sqlerrm;
  end;
end $$;

-- Only the owner hears about their own shop.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000ba';
do $$ begin
  assert shop_setup() is null, 'another barber learns nothing about this shop';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert shop_setup() is null, 'nor does a customer';
end $$;
set role anon;
do $$ begin
  perform shop_setup();
  raise exception 'guests must not call shop_setup';
exception when insufficient_privilege then null;
end $$;
rollback;

-- My shop's cards ----------------------------------------------------------------
-- shop_cards answers in one go what My shop asked five requests for. Checked
-- against those on diaries drawn at random: online customers, walk-ins with
-- numbers typed every way (an online customer's, one two accounts share, one
-- on the profile of someone who only cancelled here), walk-ins with only a
-- name or nothing, deleted accounts, blocked time, cancellations, no-shows,
-- cuts never marked done, bookings to come, cuts moved, over two years of
-- history, and reviews.
begin;
reset role;
delete from bookings;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'd1@test', '{"full_name":"Hakim","phone":"011-2233 4455"}'),
  ('00000000-0000-0000-0000-0000000000d2', 'd2@test', '{"full_name":"Farid","phone":"012-778 9012"}'),
  ('00000000-0000-0000-0000-0000000000d3', 'd3@test', '{"full_name":"Ah Seng","phone":"019-888 7777"}'),
  ('00000000-0000-0000-0000-0000000000d4', 'd4@test', '{"full_name":"Mei Ling","phone":"019-888 7777"}'),
  -- Hakim's number too, but he only goes to the other shop.
  ('00000000-0000-0000-0000-0000000000d5', 'd5@test', '{"full_name":"Hakim Senior","phone":"+60 11-2233 4455"}'),
  -- Only ever cancelled here, or came more than two years ago.
  ('00000000-0000-0000-0000-0000000000d6', 'd6@test', '{"full_name":"Zaki","phone":"017-000 1111"}'),
  ('00000000-0000-0000-0000-0000000000d7', 'd7@test', '{"full_name":"Old Timer","phone":"016-000 2222"}'),
  ('00000000-0000-0000-0000-0000000000b3', 'owner3@test', '{"role":"barber","full_name":"Rahman"}');
update profiles set phone = '013-222 3333' where id = '00000000-0000-0000-0000-0000000000c2';
insert into shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000b3', 'Kemas Cuts', 'cards-kemas-cuts');
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a8', '00000000-0000-0000-0000-00000000005c', 'Rahman');

-- First, someone on each side of every line between due and not, each a
-- walk-in with their own number, at their own time of day.
insert into bookings (shop_id, barber_id, guest_name, guest_phone, service_name, price, starts_at, ends_at, status)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', p.name,
       '012-000 ' || lpad(p.k::text, 4, '0'), 'Haircut', 25, x.at, x.at + interval '30 minutes', v.status::booking_status
from (values
  -- One visit: due from four weeks until 90 days.
  (1, 'One27', array[-27], 'completed'), (2, 'One28', array[-28], 'completed'),
  (3, 'One89', array[-89], 'completed'), (4, 'One90', array[-90], 'completed'),
  -- Due once the usual gap has passed, to the day.
  (5, 'Gap7', array[-20, -13], 'completed'), (6, 'Gap10', array[-30, -20, -10], 'completed'),
  (7, 'Gap10 early', array[-29, -19, -9], 'completed'),
  -- Gaps of 100 days: due until three gaps have gone by.
  (8, 'Big', array[-400, -300, -200], 'completed'), (9, 'Big too long', array[-500, -400, -300], 'completed'),
  (10, 'Big just', array[-499, -399, -299], 'completed'),
  -- Gaps of 10 and 21: the median 15.5 rounds up to 16, so 15 days is early.
  (11, 'Half', array[-46, -36, -15], 'completed'),
  -- At least a week, however close the visits.
  (12, 'Close', array[-10, -9], 'completed'), (13, 'Close early', array[-8, -6], 'completed'),
  -- Booked again, a cut never marked done, only a no-show, and two cuts in one day.
  (14, 'Unmarked', array[-30], 'confirmed'), (15, 'No-show', array[-30], 'no_show'),
  (16, 'Same day', array[-35, -35], 'completed')
) p(k, name, days, status)
cross join lateral unnest(p.days) with ordinality d(day, i)
cross join lateral (select p.status) v
cross join lateral (
  select ((now() at time zone 'Asia/Kuala_Lumpur')::date + d.day + time '06:00' + p.k * interval '30 minutes'
          + (d.i - 1) * interval '6 hours') at time zone 'Asia/Kuala_Lumpur' as at
) x;
insert into bookings (shop_id, barber_id, guest_name, guest_phone, service_name, price, starts_at, ends_at, status)
select '00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', 'Booked', '012-000 0017',
       'Haircut', 25, at, at + interval '30 minutes', status::booking_status
from (values ((now() at time zone 'Asia/Kuala_Lumpur')::date - 40, 'completed'),
             ((now() at time zone 'Asia/Kuala_Lumpur')::date + 2, 'confirmed')) v(day, status),
     lateral (select (day + time '12:00') at time zone 'Asia/Kuala_Lumpur' as at) x;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
begin
  assert (select array_agg(name order by name) from shop_customers(null, 50, 0) where is_due)
         = array['Big', 'Big just', 'Close', 'Gap10', 'Gap7', 'One28', 'One89', 'Same day', 'Unmarked'],
    'unexpected due: ' || (select array_agg(name order by name) from shop_customers(null, 50, 0) where is_due)::text;
  assert shop_cards(today, today) -> 'customers' = '{"total": 17, "due": 9}',
    'the card agrees on every line: ' || (shop_cards(today, today) -> 'customers')::text;
end $$;

do $$
declare
  tz text := 'Asia/Kuala_Lumpur';
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  monday date := (now() at time zone 'Asia/Kuala_Lumpur')::date
                 - (extract(isodow from (now() at time zone 'Asia/Kuala_Lumpur')::date)::int - 1);
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  kemas uuid := '00000000-0000-0000-0000-00000000005c';
  accounts uuid[] := array['00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c2',
                           '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000d2',
                           '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000d4',
                           '00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000d7'];
  phones text[] := array['019-111 2222', '+60 19-111 2222', '0191112222', '013-222 3333', '+6013 222 3333',
                         '011-2233 4455', '0112233 4455', '012-778 9012', '019-888 7777', '017-000 1111',
                         '016 000 2222', '012 555 0000', '', null];
  names text[] := array['Abu', 'Pak Abu', 'Kamal', 'Uncle Lim', 'uncle  LIM', 'Walk-in', ' walk-in', 'Deleted account'];
  statuses text[] := array['completed', 'completed', 'completed', 'completed', 'confirmed', 'cancelled', 'no_show'];
  periods date[] := array[monday, monday + 6, monday - 7, monday - 1, date_trunc('month', today)::date,
                          (date_trunc('month', today) + interval '1 month - 1 day')::date, today - 92, today,
                          today + 1, today + 7, today - 730, today - 724];
  cards jsonb;
  list jsonb;
  seen_due int := 0;
  seen_matched int := 0;
begin
  for seed in 1 .. 8 loop
    perform setseed(seed / 10.0);
    delete from bookings where shop_id in (shop, kemas);
    -- One booking a week per chair, at a random day and time in it, from
    -- 800 days ago to 40 days ahead, so none overlap.
    insert into bookings (shop_id, barber_id, customer_id, guest_name, guest_phone, is_block, service_name, price,
                          starts_at, ends_at, status)
    select shop, case when r.n % 2 = 0 then '00000000-0000-0000-0000-0000000000a1'::uuid
                      else '00000000-0000-0000-0000-0000000000a2'::uuid end,
           case when r.kind < 0.5 then accounts[1 + floor(r.who * array_length(accounts, 1))::int] end,
           case when r.kind >= 0.5 and r.kind < 0.93 then names[1 + floor(r.who * array_length(names, 1))::int] end,
           case when r.kind >= 0.5 and r.kind < 0.93 then phones[1 + floor(r.phone * array_length(phones, 1))::int] end,
           r.kind >= 0.93, 'Haircut', 10 + floor(r.price * 30), x.at, x.at + interval '30 minutes',
           statuses[1 + floor(r.status * array_length(statuses, 1))::int]::booking_status
    from (select n, random() as kind, random() as who, random() as phone, random() as price, random() as status,
                 random() as day, random() as slot
          from generate_series(0, 239) n) r
    cross join lateral (
      select ((today - 800 + (r.n / 2) * 7 + floor(r.day * 7)::int) + time '08:00'
              + floor(r.slot * 24)::int * interval '30 minutes') at time zone tz as at
    ) x;
    -- Some moved within their week, by the customer or the shop.
    update bookings b set starts_at = b.starts_at + d.shift, ends_at = b.ends_at + d.shift,
                          customer_change = case when b.customer_id is not null then 'moved' end,
                          customer_changed_at = case when b.customer_id is not null then now() end
    from (select id, (1 + floor(random() * 3))::int * interval '1 hour' as shift
          from bookings where shop_id = shop and random() < 0.2) d
    where b.id = d.id;
    -- The other shop has Hakim Senior and Ben.
    insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at, status)
    select kemas, '00000000-0000-0000-0000-0000000000a8', c, 'Haircut', 20, at, at + interval '30 minutes', 'completed'
    from (values ('00000000-0000-0000-0000-0000000000d5'::uuid, now() - interval '30 days'),
                 ('00000000-0000-0000-0000-0000000000c1'::uuid, now() - interval '31 days')) v(c, at);
    -- About one in five finished cuts by an online customer is rated, half with a comment.
    insert into reviews (booking_id, shop_id, barber_id, customer_id, rating, comment, first_name, created_at)
    select id, shop_id, barber_id, customer_id, 1 + floor(random() * 5),
           case when random() < 0.5 then 'Kemas ' || n end, 'Ben', ends_at + random() * interval '3 days'
    from (select b.*, row_number() over () as n from bookings b
          where b.shop_id = shop and b.status = 'completed' and b.customer_id is not null) b
    where random() < 0.2;

    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
    cards := shop_cards(monday, monday + 6);
    select jsonb_build_object('total', coalesce(max(total_count), 0), 'due', coalesce(max(due_count), 0))
    into list from shop_customers(null, 1, 0);
    assert cards -> 'customers' = list, format('seed %s: the card says %s, the list %s', seed, cards -> 'customers', list);
    seen_due := seen_due + (list ->> 'due')::int;
    -- Walk-ins under Hakim's number while he is a customer here: counted as him.
    seen_matched := seen_matched + (
      select count(*) from bookings g
      where g.shop_id = shop and g.customer_id is null and not g.is_block and g.status <> 'cancelled'
        and g.guest_phone in ('011-2233 4455', '0112233 4455') and g.starts_at >= now() - interval '2 years'
        and exists (select 1 from bookings a
                    where a.shop_id = shop and a.customer_id = '00000000-0000-0000-0000-0000000000d1'
                      and not a.is_block and a.status <> 'cancelled' and a.starts_at >= now() - interval '2 years'));
    for i in 1 .. array_length(periods, 1) / 2 loop
      assert shop_cards(periods[2 * i - 1], periods[2 * i]) -> 'takings'
             = shop_summary(periods[2 * i - 1], periods[2 * i]) -> 'totals',
        format('seed %s: takings %s to %s', seed, periods[2 * i - 1], periods[2 * i]);
    end loop;
    assert cards -> 'reviews' = jsonb_build_object(
        'count', (select count(*) from reviews where shop_id = shop),
        'sum', (select coalesce(sum(rating), 0) from reviews where shop_id = shop),
        'newest', (select jsonb_build_object('rating', rating, 'comment', comment, 'first_name', first_name)
                   from reviews where shop_id = shop and comment is not null order by created_at desc limit 1)),
      format('seed %s: reviews %s', seed, cards -> 'reviews');

    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b3', true);
    assert shop_cards(monday, monday + 6) -> 'customers' = '{"total": 2, "due": 2}',
      'the other shop counts its own two: ' || (shop_cards(monday, monday + 6) -> 'customers')::text;
  end loop;
  assert seen_due > 0 and seen_matched > 0, 'the diaries had people due, and walk-ins matched to an account';

  -- Days the shop is closed, from today to 60 days ahead, as Holidays lists them.
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', true);
  assert shop_cards(monday, monday + 6) -> 'closures' = '[]', 'none yet';
  insert into shop_closures (shop_id, day, reason) values
    (shop, today - 1, 'Yesterday'), (shop, today, null), (shop, today + 30, 'Hari Raya'), (shop, today + 31, 'Hari Raya'),
    (shop, today + 60, 'Last'), (shop, today + 61, 'Too far'), (kemas, today + 2, 'Another shop');
  cards := shop_cards(monday, monday + 6);
  assert cards -> 'closures' = jsonb_build_array(
      jsonb_build_object('day', today, 'reason', null), jsonb_build_object('day', today + 30, 'reason', 'Hari Raya'),
      jsonb_build_object('day', today + 31, 'reason', 'Hari Raya'), jsonb_build_object('day', today + 60, 'reason', 'Last')),
    'closed days ahead with the reason: ' || (cards -> 'closures')::text;
  assert cards -> 'closures' = (select jsonb_agg(jsonb_build_object('day', day, 'reason', reason) order by day)
                                from shop_closed_days(shop, today, today + 60) where is_closure),
    'as shop_closed_days gives them';
  -- With no comments, there is no newest.
  update reviews set comment = null where shop_id = shop;
  assert shop_cards(monday, monday + 6) #> '{reviews,newest}' = 'null', 'no comment to show';
end $$;

-- Only the owner, for their own shop, and the counts only through shop_cards.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  begin
    perform shop_cards(current_date - 93, current_date);
    raise exception '94 days should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Pick a period of up to 93 days.', 'unexpected message: ' || sqlerrm;
  end;
  begin
    perform shop_cards(null, current_date);
    raise exception 'a period without a start should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform shop_customer_counts('00000000-0000-0000-0000-00000000005a');
    raise exception 'owners must not call shop_customer_counts';
  exception when insufficient_privilege then null;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform shop_cards(current_date, current_date + 6);
  raise exception 'customers have no shop cards';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'Set up your shop first.', 'unexpected message: ' || sqlerrm;
end $$;
reset role;
set role anon;
do $$ begin
  perform shop_cards(current_date, current_date + 6);
  raise exception 'guests must not call shop_cards';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform shop_customer_counts('00000000-0000-0000-0000-00000000005a');
  raise exception 'guests must not call shop_customer_counts';
exception when insufficient_privilege then null;
end $$;
rollback;

-- Waiting list -------------------------------------------------------------------
-- A customer who finds a day full asks to hear if a time frees up; the shop
-- sees who is waiting that day and WhatsApps them a time. Ali works
-- 08:00-22:00 every day by now and Danial has no hours. Days are a month
-- out, clear of everything above, so it reads the same at any hour. Dawud is
-- a customer and Rahman another shop's owner, both for this part only.
begin;
reset role;
delete from bookings
where starts_at >= ((now() at time zone 'Asia/Kuala_Lumpur')::date + 25)::timestamp at time zone 'Asia/Kuala_Lumpur'
   or (customer_id = '00000000-0000-0000-0000-0000000000c1' and starts_at > now());
update shops set is_published = true, trial_ends_at = now() + interval '30 days'
where id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c5', 'cust5@test', '{"role":"customer","full_name":"Dawud","phone":"011-222 3333"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug, is_published) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts', true);
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005b', 'Rahman');
insert into services (id, shop_id, name, duration_min, price) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000005b', 'Fade', 45, 30),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-00000000005a', 'Old style', 30, 20);
update services set is_active = false where id = '00000000-0000-0000-0000-0000000000e4';
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a3', d, '10:00', '18:00' from generate_series(0, 6) d;
-- A request from a day gone by, written straight in: nothing clears it on a
-- timer, so every list has to leave it out.
insert into waitlist (shop_id, customer_id, day, service_id, created_at) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000c1',
   (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '00000000-0000-0000-0000-0000000000e1', now() - interval '2 days');

-- Guests can't ask, and nobody reads or writes the table itself.
set role anon;
do $$ begin
  perform join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date + 30);
  raise exception 'guests must not join a waiting list';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform my_waitlist();
  raise exception 'guests must not call my_waitlist';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform shop_waitlist((now() at time zone 'Asia/Kuala_Lumpur')::date + 30);
  raise exception 'guests must not call shop_waitlist';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform leave_waitlist(gen_random_uuid());
  raise exception 'guests must not call leave_waitlist';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform mark_waitlist_offered(gen_random_uuid());
  raise exception 'guests must not call mark_waitlist_offered';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform max_waiting_per_customer();
  raise exception 'max_waiting_per_customer is only for the functions';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform 1 from waitlist;
  raise exception 'guests must not read the waiting list';
exception when insufficient_privilege then null;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform 1 from waitlist;
  raise exception 'customers must not read the waiting list directly';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  insert into waitlist (shop_id, customer_id, day, service_id)
  values ('00000000-0000-0000-0000-00000000005a', auth.uid(), (now() at time zone 'Asia/Kuala_Lumpur')::date + 30,
          '00000000-0000-0000-0000-0000000000e1');
  raise exception 'customers must not write the waiting list directly';
exception when insufficient_privilege then null;
end $$;

-- Ben joins for day 30 with any barber and day 31 with Ali.
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  w waitlist;
begin
  w := join_waitlist('00000000-0000-0000-0000-0000000000e1', d);
  assert w.customer_id = auth.uid() and w.shop_id = '00000000-0000-0000-0000-00000000005a' and w.day = d
     and w.barber_id is null and w.offered_at is null and w.created_at = now(), 'a request for any barber: ' || w::text;
  perform set_config('test.ben_any', w.id::text, false);
  w := join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 1, '00000000-0000-0000-0000-0000000000a1');
  assert w.barber_id = '00000000-0000-0000-0000-0000000000a1', 'a request for Ali';
  perform set_config('test.ben_ali', w.id::text, false);

  -- Once a day per shop, whatever the service or barber.
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d, '00000000-0000-0000-0000-0000000000a1');
    raise exception 'one request a day per shop';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'You''re already on the waiting list for that day.', sqlerrm;
  end;

  -- Only a day they could book.
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1);
    raise exception 'a day gone by should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Pick a day from today up to 60 days ahead.', sqlerrm;
  end;
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date + 61);
    raise exception 'a day past the booking horizon should be refused';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e4', d + 2);
    raise exception 'a hidden service should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'This service is no longer available.', sqlerrm;
  end;
  begin
    perform join_waitlist(gen_random_uuid(), d + 2);
    raise exception 'an unknown service should be refused';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 2, '00000000-0000-0000-0000-0000000000a3');
    raise exception 'another shop''s barber should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  -- Danial has no hours, so his days are never full: there is nothing to wait for.
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 2, '00000000-0000-0000-0000-0000000000a2');
    raise exception 'a barber who doesn''t work that day should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'That barber is off that day. Try any barber.', sqlerrm;
  end;
  assert jsonb_array_length(my_waitlist()) = 2, 'nothing refused was kept: ' || my_waitlist()::text;
end $$;

-- Closed days, a whole day off, a paused shop.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
begin
  perform close_shop_days(d + 3, 1, 'Kenduri');
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 4, '00:00', 1440, p_is_block => true);
  -- Half a day off still leaves the evening.
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 5, '08:00', 360, p_is_block => true);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  w waitlist;
begin
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 3);
    raise exception 'a closed day should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'The shop isn''t taking bookings that day.', sqlerrm;
  end;
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 4, '00000000-0000-0000-0000-0000000000a1');
    raise exception 'a day everyone has off should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'The shop isn''t taking bookings that day.', sqlerrm;
  end;
  w := join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 5, '00000000-0000-0000-0000-0000000000a1');
  assert w.day = d + 5, 'half a day off is still a working day';
end $$;

-- One barber's whole day off, with the other in: everyone sees it, without
-- the reason, so the booking page shows that barber off rather than full,
-- and asking to wait for them says so (the day went off with the page open).
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform set_barber_hours('00000000-0000-0000-0000-0000000000a2',
    (select jsonb_agg(jsonb_build_object('weekday', d, 'opens_at', '10:00', 'closes_at', '18:00'))
     from generate_series(0, 6) d));
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a2', (now() at time zone 'Asia/Kuala_Lumpur')::date + 38,
    '00:00', 1440, p_note => 'Cuti', p_is_block => true);
end $$;
reset role;
set request.jwt.claim.sub = '';
set role anon;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 38;
begin
  assert (select array_agg(row(day, reason, is_closure, barber_id)::text) from shop_closed_days('00000000-0000-0000-0000-00000000005a', d, d))
         = array[row(d, null, false, '00000000-0000-0000-0000-0000000000a2'::uuid)::text], 'Danial is off that day';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 38;
  w waitlist;
begin
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d, '00000000-0000-0000-0000-0000000000a2');
    raise exception 'waiting for a barber who has the day off should be refused';
  exception when sqlstate '22023' then
    assert sqlerrm = 'That barber is off that day. Try any barber.', sqlerrm;
  end;
  w := join_waitlist('00000000-0000-0000-0000-0000000000e1', d);
  assert w.barber_id is null, 'any barber is fine: Ali is in';
  perform leave_waitlist(w.id);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform set_barber_hours('00000000-0000-0000-0000-0000000000a2', '[]');
end $$;

reset role;
update shops set is_published = false where id = '00000000-0000-0000-0000-00000000005b';
set role authenticated;
do $$ begin
  perform join_waitlist('00000000-0000-0000-0000-0000000000e3', (now() at time zone 'Asia/Kuala_Lumpur')::date + 30);
  raise exception 'a paused shop''s waiting list should be refused';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'This service is no longer available.', sqlerrm;
end $$;
reset role;
update shops set is_published = true where id = '00000000-0000-0000-0000-00000000005b';
set role authenticated;

-- Chong already has his four bookings on day 2: no waiting for a day he has a time.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  perform join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date + 2);
  raise exception 'someone booked that day should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'You already have a booking here that day.', sqlerrm;
end $$;

-- Three days at a time across every shop; the day gone by doesn't count and goes.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  w waitlist;
begin
  w := join_waitlist('00000000-0000-0000-0000-0000000000e3', d + 6, '00000000-0000-0000-0000-0000000000a3');
  perform set_config('test.ben_kemas', w.id::text, false);
  begin
    perform join_waitlist('00000000-0000-0000-0000-0000000000e1', d + 7);
    raise exception 'a fourth waiting list should be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'You can be on 3 waiting lists at a time. Leave one to join another.', sqlerrm;
  end;
end $$;
reset role;
do $$ begin
  assert (select count(*) from waitlist where customer_id = '00000000-0000-0000-0000-0000000000c1') = 3,
    'the day gone by was cleared when he joined';
end $$;
-- Another day gone by, to show lists leave it out.
insert into waitlist (shop_id, customer_id, day, service_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000c1',
   (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000c5',
   (now() at time zone 'Asia/Kuala_Lumpur')::date - 1, '00000000-0000-0000-0000-0000000000e1');
set role authenticated;
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  r jsonb;
begin

  -- His own, soonest first, with each shop, service and barber.
  r := my_waitlist();
  assert jsonb_array_length(r) = 3, 'Ben''s three: ' || r::text;
  assert my_bookings() -> 'waitlist' = r, 'My bookings has them too, in the same request';
  assert r -> 0 ->> 'id' = current_setting('test.ben_any') and r -> 0 ->> 'day' = d::text
     and r -> 0 ->> 'shop_id' = '00000000-0000-0000-0000-00000000005a'
     and r -> 0 ->> 'service_id' = '00000000-0000-0000-0000-0000000000e1'
     and r -> 0 ->> 'service_name' = 'Haircut' and r -> 0 -> 'barber_id' = 'null' and r -> 0 -> 'barber_name' = 'null'
     and r -> 0 -> 'shop' = '{"name": "Ali Cuts", "slug": "ali-cuts", "time_zone": "Asia/Kuala_Lumpur"}'
     and (r -> 0 ->> 'created_at')::timestamptz = now(), 'any barber at Ali Cuts: ' || (r -> 0)::text;
  assert r -> 1 ->> 'barber_name' = 'Ali' and r -> 2 ->> 'service_name' = 'Fade'
     and r -> 2 -> 'shop' ->> 'name' = 'Kemas Cuts', 'Ali on day 31, Rahman''s Fade on day 36: ' || r::text;
end $$;

-- Leaving: his own, twice over is fine; Chong can't take Ben off.
do $$ begin
  perform leave_waitlist(current_setting('test.ben_kemas')::uuid);
  perform leave_waitlist(current_setting('test.ben_kemas')::uuid);
  assert jsonb_array_length(my_waitlist()) = 2, 'Ben left Kemas Cuts';
  perform join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date + 37);
  assert jsonb_array_length(my_waitlist()) = 3, 'leaving one makes room for another';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  assert my_waitlist() = '[]', 'Chong sees nobody else''s';
  perform leave_waitlist(current_setting('test.ben_any')::uuid);
  assert not exists (select 1 from shop_waitlist((now() at time zone 'Asia/Kuala_Lumpur')::date + 30)),
    'customers see no shop''s list';
end $$;

-- Dawud joins day 30 after Ben, with Ali.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$
declare
  w waitlist;
begin
  w := join_waitlist('00000000-0000-0000-0000-0000000000e1', (now() at time zone 'Asia/Kuala_Lumpur')::date + 30,
    '00000000-0000-0000-0000-0000000000a1');
  perform set_config('test.dawud', w.id::text, false);
end $$;
reset role;
-- Ben asked first.
update waitlist set created_at = now() - interval '3 hours' where id = current_setting('test.ben_any')::uuid;
set role authenticated;

-- The owner sees who is waiting that day, oldest first, with each one's name and number.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  w waitlist;
  names text[];
begin
  select array_agg(s.name || '|' || coalesce(s.phone, '-') || '|' || s.service_name || '|' || s.duration_min
                   || '|' || coalesce(s.barber_name, 'any') order by ord)
  into names
  from shop_waitlist(d) with ordinality s(id, name, phone, service_id, service_name, duration_min,
                                          barber_id, barber_name, created_at, offered_at, ord);
  assert names = array['Ben|-|Haircut|30|any', 'Dawud|011-222 3333|Haircut|30|Ali'],
    'Ben (still on it) then Dawud: ' || names::text;
  assert (select count(*) from shop_waitlist(d + 1)) = 1, 'Ben with Ali on day 31';
  assert (select count(*) from shop_waitlist((now() at time zone 'Asia/Kuala_Lumpur')::date - 1)) = 0,
    'a day gone by is empty';
  assert (select count(*) from shop_waitlist(d + 6)) = 0, 'Kemas Cuts'' list isn''t Ali''s';

  -- WhatsApping someone marks them offered for every phone.
  w := mark_waitlist_offered(current_setting('test.ben_any')::uuid);
  assert w.offered_at = now(), 'offered now';
  assert (select offered_at from shop_waitlist(d) s where s.id = w.id) = now(), 'the list shows it';

  -- The owner takes Dawud off.
  perform leave_waitlist(current_setting('test.dawud')::uuid);
  assert (select count(*) from shop_waitlist(d)) = 1, 'Dawud is off the list';
  begin
    perform mark_waitlist_offered(current_setting('test.dawud')::uuid);
    raise exception 'someone gone can''t be offered';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'They''re no longer on the waiting list.', sqlerrm;
  end;
end $$;

-- Nobody else: Ben can't mark himself offered, and another shop's owner sees and touches nothing.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform mark_waitlist_offered(current_setting('test.ben_ali')::uuid);
  raise exception 'customers can''t mark an offer';
exception when sqlstate 'P0002' then null;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  assert not exists (select 1 from shop_waitlist((now() at time zone 'Asia/Kuala_Lumpur')::date + 30)),
    'another shop''s owner sees nothing';
  perform leave_waitlist(current_setting('test.ben_ali')::uuid);
  begin
    perform mark_waitlist_offered(current_setting('test.ben_ali')::uuid);
    raise exception 'another shop''s owner can''t mark an offer';
  exception when sqlstate 'P0002' then null;
  end;
end $$;
reset role;
do $$ begin
  assert exists (select 1 from waitlist where id = current_setting('test.ben_ali')::uuid and offered_at is null),
    'Ben''s day 31 is untouched';
end $$;
set role authenticated;

-- A cancellation on a day people are waiting for tells the shop so. Dawud
-- books day 30 at 10:00 and cancels it, and books day 32 (nobody waiting).
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  b bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '10:00') at time zone 'Asia/Kuala_Lumpur');
  b := set_booking_status(b.id, 'cancelled');
  perform set_config('test.dawud_cancel', b.id::text, false);
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + 2 + time '10:00') at time zone 'Asia/Kuala_Lumpur');
  b := set_booking_status(b.id, 'cancelled');
  perform set_config('test.dawud_cancel_2', b.id::text, false);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  r jsonb := shop_changes(null, 20);
begin
  assert (select (e ->> 'waiting')::int from jsonb_array_elements(r -> 'changes') e
          where e ->> 'booking_id' = current_setting('test.dawud_cancel')) = 1,
    'Ben is waiting for day 30: ' || r::text;
  assert (select (e ->> 'waiting')::int from jsonb_array_elements(r -> 'changes') e
          where e ->> 'booking_id' = current_setting('test.dawud_cancel_2')) = 0,
    'nobody is waiting for day 32: ' || r::text;
  assert (select bool_and((e ->> 'waiting')::int = 0) from jsonb_array_elements(r -> 'changes') e
          where e ->> 'change' <> 'cancelled'), 'only a cancellation says who is waiting';
end $$;

-- Booking that day ends the request, and so does moving a booking into it.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
  b bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (d + time '10:00') at time zone 'Asia/Kuala_Lumpur');
  assert (select array_agg((e ->> 'day')::date order by e ->> 'day') from jsonb_array_elements(my_waitlist()) e)
         = array[d + 1, d + 7], 'booked day 30, so no longer waiting for it: ' || my_waitlist()::text;
  b := reschedule_booking(b.id, (d + 1 + time '11:00') at time zone 'Asia/Kuala_Lumpur');
  assert (select array_agg((e ->> 'day')::date) from jsonb_array_elements(my_waitlist()) e) = array[d + 7],
    'moved into day 31, so no longer waiting for it either: ' || my_waitlist()::text;
end $$;
-- The shop moving a customer's booking into a day they wait on ends it too.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 30;
begin
  perform reschedule_booking(
    (select id from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1' and status = 'confirmed'
       and starts_at = (d + 1 + time '11:00') at time zone 'Asia/Kuala_Lumpur'),
    (d + 7 + time '09:00') at time zone 'Asia/Kuala_Lumpur');
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert my_waitlist() = '[]', 'the shop moved him into day 37: ' || my_waitlist()::text;
end $$;

-- The shop putting someone waiting in by hand (after a WhatsApp, say) ends
-- their request: their number finds them, however it was typed. Another
-- number, another day or blocked time doesn't.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 35;
begin
  assert (select array_agg(name) from shop_waitlist(d)) = array['Dawud'], 'Dawud waits for day 35';
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '20:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Someone else', '011-222 3334');
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d + 1, '20:00', null,
    '00000000-0000-0000-0000-0000000000e1', 'Dawud', '011-222 3333');
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '21:00', 30, p_is_block => true);
  assert (select array_agg(name) from shop_waitlist(d)) = array['Dawud'], 'still waiting';
  perform add_shop_booking('00000000-0000-0000-0000-0000000000a1', d, '20:30', null,
    '00000000-0000-0000-0000-0000000000e1', 'Dawud', '+60 11-222 3333');
  assert not exists (select 1 from shop_waitlist(d)), 'put in by hand, so no longer waiting';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$ begin
  assert my_waitlist() = '[]', 'his list says so too: ' || my_waitlist()::text;
end $$;

-- Deleting an account takes its requests with it.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c5';
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert not exists (select 1 from waitlist where customer_id = '00000000-0000-0000-0000-0000000000c5'),
    'a deleted account waits for nothing';
end $$;
rollback;

-- Walk-in queue ------------------------------------------------------------------
-- Customers join a shop's queue for today from its page; the shop adds
-- walk-ins, calls them in turn and starts each cut as a booking. Ali and
-- Danial work all day every day here, so the shop is open whatever the hour,
-- and bookings in the way are put next to now. Hakim and Siti are
-- customers, and Rahman another shop's owner, for this part only.
begin;
reset role;
delete from bookings;
delete from shop_closures;
delete from working_hours
where barber_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select b, d, '00:00', '24:00'
from unnest(array['00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2']::uuid[]) b,
     generate_series(0, 6) d;
update barbers set is_active = true where shop_id = '00000000-0000-0000-0000-00000000005a';
update shops set is_published = true, subscription_status = 'active', queue_enabled = false
where id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000c6', 'hakim.q@test', '{"role":"customer","full_name":"Hakim","phone":"011-2233 4455"}'),
  ('00000000-0000-0000-0000-0000000000c7', 'siti.q@test', '{"role":"customer","full_name":"Siti","phone":"019-555 1234"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005b', 'Rahman');
insert into services (id, shop_id, name, duration_min, price) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-00000000005b', 'Fade', 45, 30),
  ('00000000-0000-0000-0000-0000000000e5', '00000000-0000-0000-0000-00000000005a', 'Skin fade', 45, 35);
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a3', d, '00:00', '24:00' from generate_series(0, 6) d;
update shops set is_published = true, queue_enabled = true where id = '00000000-0000-0000-0000-00000000005b';
-- Hakim's place yesterday, written straight in and never ended: nothing
-- clears it on a timer, so everything has to leave it out.
insert into queue_entries (shop_id, day, customer_id, service_id, created_at) values
  ('00000000-0000-0000-0000-00000000005a', (now() at time zone 'Asia/Kuala_Lumpur')::date - 1,
   '00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000e1', now() - interval '1 day');
do $$ begin perform set_config('test.yesterday', (select id::text from queue_entries), false); end $$;

do $$ begin
  assert queue_estimate(0, 2) = 0 and queue_estimate(null, 2) = 0, 'nobody waiting is no wait';
  assert queue_estimate(75, 2) = 40, '75 minutes over two chairs is about 40';
  assert queue_estimate(30, 1) = 30 and queue_estimate(31, 1) = 35, 'rounded up to 5 minutes';
  assert queue_estimate(45, 0) = 45, 'nobody in counts as one chair';
end $$;

-- Guests see how many wait and how long, but can't join, and nobody reads
-- or writes the table itself.
set role anon;
do $$
declare
  s jsonb := queue_status('00000000-0000-0000-0000-00000000005a');
begin
  assert s = jsonb_build_object('open', false, 'waiting', 0, 'estimate_min', 0, 'barbers_in', 2, 'mine', null),
    'the queue is off, so it isn''t open: ' || s::text;
  assert (select queue_waiting from find_shops() where id = '00000000-0000-0000-0000-00000000005a') is null,
    'Find a barber has no count for a shop without a queue';
  assert (select queue_waiting from find_shops() where id = '00000000-0000-0000-0000-00000000005b') = 0,
    'and nobody waiting at one with a queue';
end $$;
do $$ begin
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'guests must not join a queue';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform my_queue();
  raise exception 'guests must not call my_queue';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform shop_queue();
  raise exception 'guests must not call shop_queue';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform add_to_queue('Pak Long');
  raise exception 'guests must not call add_to_queue';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform start_from_queue(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1');
  raise exception 'guests must not call start_from_queue';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform barbers_in_now('00000000-0000-0000-0000-00000000005a', 'Asia/Kuala_Lumpur');
  raise exception 'barbers_in_now is only for the functions';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform 1 from queue_entries;
  raise exception 'guests must not read the queue';
exception when insufficient_privilege then null;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$ begin
  perform 1 from queue_entries;
  raise exception 'customers must not read the queue directly';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  insert into queue_entries (shop_id, day, customer_id)
  values ('00000000-0000-0000-0000-00000000005a', (now() at time zone 'Asia/Kuala_Lumpur')::date, auth.uid());
  raise exception 'customers must not write the queue directly';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'a shop without a queue should refuse';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'The queue isn''t open right now.', sqlerrm;
end $$;
-- Only the owner turns it on.
do $$ begin
  update shops set queue_enabled = true where id = '00000000-0000-0000-0000-00000000005a';
  assert not (select queue_enabled from shops where id = '00000000-0000-0000-0000-00000000005a'),
    'a customer can''t turn on a shop''s queue';
end $$;

set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform add_to_queue('Pak Long');
  raise exception 'adding to a queue that is off should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'Turn on the walk-in queue in My shop first.', sqlerrm;
end $$;
update shops set queue_enabled = true where id = '00000000-0000-0000-0000-00000000005a';

-- Pak Long walks in first, with no service said yet.
do $$
declare
  e queue_entries;
begin
  begin
    perform add_to_queue('  ');
    raise exception 'a walk-in needs a name';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Add the customer''s name.', sqlerrm;
  end;
  begin
    perform add_to_queue('Pak Long', null, '00000000-0000-0000-0000-0000000000e3');
    raise exception 'another shop''s service should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'Service not found.', sqlerrm;
  end;
  begin
    perform add_to_queue('Pak Long', null, null, '00000000-0000-0000-0000-0000000000a3');
    raise exception 'another shop''s barber should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  e := add_to_queue(' Pak Long ', ' 012-111 2222 ');
  assert e.guest_name = 'Pak Long' and e.guest_phone = '012-111 2222' and e.customer_id is null
     and e.service_id is null and e.barber_id is null and e.state = 'waiting'
     and e.shop_id = '00000000-0000-0000-0000-00000000005a'
     and e.day = (now() at time zone 'Asia/Kuala_Lumpur')::date, 'Pak Long waits: ' || e::text;
  perform set_config('test.pak_long', e.id::text, false);
end $$;

-- Hakim joins online for a skin fade with any barber: second in line.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$
declare
  e queue_entries;
  s jsonb;
begin
  begin
    perform join_queue('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a3');
    raise exception 'another shop''s barber should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  begin
    perform join_queue(gen_random_uuid());
    raise exception 'an unknown service should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'This service is no longer available.', sqlerrm;
  end;
  e := join_queue('00000000-0000-0000-0000-0000000000e5');
  assert e.customer_id = auth.uid() and e.guest_name is null and e.barber_id is null and e.state = 'waiting'
     and e.service_id = '00000000-0000-0000-0000-0000000000e5', 'Hakim waits: ' || e::text;
  perform set_config('test.hakim', e.id::text, false);

  -- One place at a time, here or anywhere.
  begin
    perform join_queue('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1');
    raise exception 'joining twice should be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'You''re already in this queue.', sqlerrm;
  end;
  begin
    perform join_queue('00000000-0000-0000-0000-0000000000e3');
    raise exception 'joining a second shop''s queue should be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'You''re already in another shop''s queue. Leave it to join this one.', sqlerrm;
  end;

  -- Pak Long counts as the shop's shortest service, a 30-minute haircut:
  -- 75 minutes over two chairs is about 40, and Hakim has 30 ahead of him.
  s := queue_status('00000000-0000-0000-0000-00000000005a');
  assert s->>'open' = 'true' and (s->>'waiting')::int = 2 and (s->>'estimate_min')::int = 40
     and (s->>'barbers_in')::int = 2, 'the shop''s queue: ' || s::text;
  assert s->'mine'->>'id' = e.id::text and s->'mine'->>'state' = 'waiting'
     and (s->'mine'->>'place')::int = 2 and (s->'mine'->>'estimate_min')::int = 15,
    'Hakim is second, about 15 minutes away: ' || s::text;
  s := my_queue();
  assert jsonb_array_length(s) = 1 and s->0->>'id' = e.id::text and (s->0->>'place')::int = 2
     and s->0->>'service_name' = 'Skin fade' and s->0->>'barber_name' is null
     and s->0->'shop'->>'name' = 'Ali Cuts' and s->0->'shop'->>'slug' = 'ali-cuts',
    'My bookings shows his place: ' || s::text;
  assert my_bookings() -> 'queue' = s, 'and gets it with the bookings, in the same request';
  assert (select queue_waiting from find_shops() where id = '00000000-0000-0000-0000-00000000005a') = 2,
    'Find a barber shows 2 waiting';
end $$;
-- Others see the count, never who.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare
  s jsonb := queue_status('00000000-0000-0000-0000-00000000005a');
begin
  assert (s->>'waiting')::int = 2 and s->'mine' = 'null', 'Chong sees two waiting: ' || s::text;
  assert my_queue() = '[]', 'and isn''t in it';
  assert not exists (select 1 from shop_queue()), 'nor sees the shop''s list';
end $$;

-- Siti has a booking here today, so she has a time: no queue for her until
-- it is cancelled. A day of Danial's off, and he can't be asked for.
reset role;
insert into bookings (shop_id, barber_id, customer_id, service_name, price, starts_at, ends_at)
values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2',
        '00000000-0000-0000-0000-0000000000c7', 'Haircut', 25,
        (now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'Asia/Kuala_Lumpur',
        ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1)::timestamp at time zone 'Asia/Kuala_Lumpur');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c7';
do $$ begin
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'someone with a booking today should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'You already have a booking here today.', sqlerrm;
end $$;
reset role;
update bookings set status = 'cancelled' where customer_id = '00000000-0000-0000-0000-0000000000c7';
insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', true, 'Cuti', 0,
        (now() at time zone 'Asia/Kuala_Lumpur')::date::timestamp at time zone 'Asia/Kuala_Lumpur',
        ((now() at time zone 'Asia/Kuala_Lumpur')::date + 1)::timestamp at time zone 'Asia/Kuala_Lumpur');
set role authenticated;
do $$
declare
  e queue_entries;
begin
  begin
    perform join_queue('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2');
    raise exception 'a barber with the day off should be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'That barber isn''t in right now. Try any barber.', sqlerrm;
  end;
  assert (queue_status('00000000-0000-0000-0000-00000000005a')->>'barbers_in')::int = 1, 'only Ali is in';
  e := join_queue('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1');
  assert e.barber_id = '00000000-0000-0000-0000-0000000000a1', 'Siti asks for Ali';
  perform set_config('test.siti', e.id::text, false);
end $$;
reset role;
delete from bookings where is_block;

-- Closed today: no queue, though everyone is on the list.
insert into shop_closures (shop_id, day)
values ('00000000-0000-0000-0000-00000000005a', (now() at time zone 'Asia/Kuala_Lumpur')::date);
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$
declare
  s jsonb := queue_status('00000000-0000-0000-0000-00000000005a');
begin
  assert s->>'open' = 'false' and (s->>'barbers_in')::int = 0, 'a closed shop''s queue isn''t open: ' || s::text;
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'joining on a closed day should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'The queue isn''t open right now.', sqlerrm;
end $$;
reset role;
delete from shop_closures;

-- Thirty waiting at most, online or added by the shop.
insert into queue_entries (shop_id, day, guest_name, created_at)
select '00000000-0000-0000-0000-00000000005a', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'Extra ' || n, now()
from generate_series(1, 27) n;
set role authenticated;
do $$ begin
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'a full queue should refuse';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'The queue is full for now. Try booking a time instead.', sqlerrm;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform add_to_queue('One more');
  raise exception 'a full queue should refuse the shop too';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'The queue is full for now. Try booking a time instead.', sqlerrm;
end $$;
reset role;
delete from queue_entries where guest_name like 'Extra %';
set role authenticated;

-- The shop's list: today's, in order, with names and numbers.
do $$ begin
  assert (select array_agg(row(name, phone, online, service_name, barber_name, state)::text order by created_at)
          from shop_queue())
         = array[row('Pak Long', '012-111 2222', false, null, null, 'waiting')::text,
                 row('Hakim', '011-2233 4455', true, 'Skin fade', null, 'waiting')::text,
                 row('Siti', '019-555 1234', true, 'Haircut', 'Ali', 'waiting')::text],
    'the shop''s queue: ' || (select array_agg(row(name, phone, online, service_name, barber_name, state)::text) from shop_queue())::text;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$ begin
  assert not exists (select 1 from shop_queue()), 'another shop sees none of it';
  perform call_from_queue(current_setting('test.hakim')::uuid);
  raise exception 'another shop can''t call Hakim';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'They''re no longer in the queue.', sqlerrm;
end $$;
do $$ begin
  perform remove_from_queue(current_setting('test.hakim')::uuid);
  perform start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a3');
  raise exception 'another shop can''t start Hakim''s cut';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'Set up your shop first.' or sqlerrm = 'They''re no longer in the queue.', sqlerrm;
end $$;

-- Ali calls Hakim: it's his turn, and Siti moves up to second.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  e queue_entries;
begin
  e := call_from_queue(current_setting('test.hakim')::uuid);
  assert e.state = 'called' and e.called_at = now(), 'Hakim is called: ' || e::text;
  begin
    perform call_from_queue(current_setting('test.yesterday')::uuid);
    raise exception 'yesterday''s place can''t be called';
  exception when sqlstate 'P0002' then null;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$
declare
  s jsonb := queue_status('00000000-0000-0000-0000-00000000005a');
begin
  assert s->'mine'->>'state' = 'called' and s->'mine'->'place' = 'null' and s->'mine'->>'called_at' is not null,
    'Hakim sees it is his turn: ' || s::text;
  assert (s->>'waiting')::int = 2, 'two still waiting';
  assert my_queue()->0->>'state' = 'called', 'My bookings says so too';
  -- Called still holds his place, so no other queue.
  perform join_queue('00000000-0000-0000-0000-0000000000e3');
  raise exception 'someone called should not join another queue';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'You''re already in another shop''s queue. Leave it to join this one.', sqlerrm;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c7';
do $$ begin
  assert (queue_status('00000000-0000-0000-0000-00000000005a')->'mine'->>'place')::int = 2, 'Siti is second now';
end $$;

-- Starting Hakim's cut: Danial has a booking before a skin fade would end,
-- and Ali is still on a cut, so both say so; once Ali is free it is a
-- booking from now.
reset role;
insert into bookings (shop_id, barber_id, guest_name, service_name, price, starts_at, ends_at) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a2', 'Later', 'Haircut', 25,
   now() + interval '20 minutes', now() + interval '50 minutes'),
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', 'Before', 'Haircut', 25,
   now() - interval '25 minutes', now() + interval '5 minutes');
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  detail text;
begin
  begin
    perform start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a3');
    raise exception 'another shop''s barber should be refused';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  begin
    perform start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a2');
    raise exception 'a booking in the way should be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics detail = pg_exception_detail;
    assert sqlerrm ~ ('^Danial has an? ' || lower(to_char((now() + interval '20 minutes') at time zone 'Asia/Kuala_Lumpur', 'FMHH12:MI AM'))
                      || ' booking before this cut would finish\. Pick another barber\.$'),
      sqlerrm;
    assert detail::timestamptz = now() + interval '20 minutes', 'the detail is when: ' || detail;
  end;
  begin
    perform start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a1');
    raise exception 'a barber on a cut should be refused';
  exception when sqlstate 'P0001' then
    get stacked diagnostics detail = pg_exception_detail;
    assert sqlerrm = format('Ali is busy until %s. Pick another barber.',
                            lower(to_char((now() + interval '5 minutes') at time zone 'Asia/Kuala_Lumpur', 'FMHH12:MI AM'))),
      sqlerrm;
    assert detail::timestamptz = now() + interval '5 minutes', 'the detail is until when: ' || detail;
  end;
end $$;
reset role;
update bookings set status = 'cancelled' where guest_name = 'Before';
set role authenticated;
do $$
declare
  b bookings;
  e queue_entries;
begin
  b := start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a1');
  assert b.starts_at = date_trunc('minute', now()) and b.ends_at = b.starts_at + interval '45 minutes'
     and b.barber_id = '00000000-0000-0000-0000-0000000000a1' and b.customer_id = '00000000-0000-0000-0000-0000000000c6'
     and b.guest_name is null and b.service_name = 'Skin fade' and b.price = 35 and b.status = 'confirmed'
     and not b.is_block and b.customer_changed_at is null, 'Hakim''s cut is a booking: ' || b::text;
  reset role;
  select * into e from queue_entries where id = current_setting('test.hakim')::uuid;
  assert e.state = 'gone' and e.gone_reason = 'served' and e.booking_id = b.id, 'and he left the queue served';
  set role authenticated;
  begin
    perform start_from_queue(current_setting('test.hakim')::uuid, '00000000-0000-0000-0000-0000000000a2');
    raise exception 'a cut can''t start twice';
  exception when sqlstate 'P0002' then
    assert sqlerrm = 'They''re no longer in the queue.', sqlerrm;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$ begin
  assert my_queue() = '[]', 'Hakim is no longer waiting';
  assert queue_status('00000000-0000-0000-0000-00000000005a')->'mine' = 'null', 'nor on the shop''s page';
  assert (select count(*) from jsonb_array_elements(my_bookings() -> 'bookings') x
          where x->>'service_name' = 'Skin fade' and (x->>'starts_at')::timestamptz = date_trunc('minute', now())) = 1,
    'his cut is in his bookings';
end $$;

-- Pak Long said no service: the shop picks one when his cut starts.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
reset role;
delete from bookings where guest_name = 'Later';
set role authenticated;
do $$
declare
  b bookings;
begin
  begin
    perform start_from_queue(current_setting('test.pak_long')::uuid, '00000000-0000-0000-0000-0000000000a2');
    raise exception 'a cut needs a service';
  exception when sqlstate '22023' then
    assert sqlerrm = 'Pick a service for their cut.', sqlerrm;
  end;
  b := start_from_queue(current_setting('test.pak_long')::uuid, '00000000-0000-0000-0000-0000000000a2',
                        '00000000-0000-0000-0000-0000000000e1');
  assert b.guest_name = 'Pak Long' and b.guest_phone = '012-111 2222' and b.customer_id is null
     and b.service_name = 'Haircut' and b.ends_at = b.starts_at + interval '30 minutes', 'Pak Long''s cut: ' || b::text;
  -- Siti didn't answer when called.
  perform call_from_queue(current_setting('test.siti')::uuid);
  perform remove_from_queue(current_setting('test.siti')::uuid);
  perform remove_from_queue(current_setting('test.siti')::uuid);
  assert not exists (select 1 from shop_queue()), 'nobody left';
end $$;
reset role;
do $$ begin
  assert (select gone_reason from queue_entries where id = current_setting('test.siti')::uuid) = 'not_here',
    'Siti wasn''t here';
  assert (select gone_at from queue_entries where id = current_setting('test.siti')::uuid) = now(), 'just now';
end $$;
set role authenticated;

-- Her page and My bookings say the shop took her off, rather than just
-- offering the queue again, so she knows to message them.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c7';
do $$
declare
  s jsonb := queue_status('00000000-0000-0000-0000-00000000005a');
begin
  assert s->'mine'->>'id' = current_setting('test.siti') and s->'mine'->>'state' = 'gone'
     and s->'mine'->>'gone_reason' = 'not_here' and s->'mine'->'place' = 'null', 'Siti is told: ' || s::text;
  s := my_queue();
  assert jsonb_array_length(s) = 1 and s->0->>'state' = 'gone' and s->0->>'gone_reason' = 'not_here'
     and s->0->'shop'->>'name' = 'Ali Cuts', 'in My bookings too: ' || s::text;
end $$;

-- Siti comes back and joins again, then leaves; Chong can't take her off.
do $$
declare
  e queue_entries := join_queue('00000000-0000-0000-0000-0000000000e1');
begin
  perform set_config('test.siti', e.id::text, false);
  assert queue_status('00000000-0000-0000-0000-00000000005a')->'mine'->>'state' = 'waiting', 'her new place counts';
  assert my_queue()->0->>'state' = 'waiting' and jsonb_array_length(my_queue()) = 1, 'and is the only one listed';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  perform leave_queue(current_setting('test.siti')::uuid);
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c7';
do $$ begin
  assert (queue_status('00000000-0000-0000-0000-00000000005a')->'mine'->>'place')::int = 1, 'still waiting, first now';
  perform leave_queue(current_setting('test.siti')::uuid);
  perform leave_queue(current_setting('test.siti')::uuid);
  assert my_queue() = '[]', 'Siti left';
end $$;
reset role;
do $$ begin
  assert (select gone_reason from queue_entries where id = current_setting('test.siti')::uuid) = 'left', 'she left';
end $$;

-- Taken off while waiting, Chong is told for an hour, then the page is as
-- it was.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin perform set_config('test.chong', join_queue('00000000-0000-0000-0000-0000000000e1')::text, false); end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin perform remove_from_queue((current_setting('test.chong')::queue_entries).id); end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c2';
do $$ begin
  assert queue_status('00000000-0000-0000-0000-00000000005a')->'mine'->>'gone_reason' = 'removed', 'Chong is told';
  assert my_queue()->0->>'gone_reason' = 'removed', 'in My bookings too';
end $$;
reset role;
update queue_entries set gone_at = now() - interval '61 minutes'
where id = (current_setting('test.chong')::queue_entries).id;
set role authenticated;
do $$ begin
  assert queue_status('00000000-0000-0000-0000-00000000005a')->'mine' = 'null', 'an hour on, his page is as it was';
  assert my_queue() = '[]', 'and so is My bookings';
end $$;

-- Five times a day at one shop, however each place ended, so joining and
-- leaving over and over can't pile up entries.
do $$
declare
  e queue_entries;
begin
  for n in 1..4 loop
    e := join_queue('00000000-0000-0000-0000-0000000000e1');
    perform leave_queue(e.id);
  end loop;
  perform join_queue('00000000-0000-0000-0000-0000000000e1');
  raise exception 'a sixth time should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'You can join this queue 5 times a day. Book a time instead.', sqlerrm;
end $$;
-- Elsewhere is another queue.
do $$
declare
  e queue_entries := join_queue('00000000-0000-0000-0000-0000000000e3');
begin
  perform leave_queue(e.id);
end $$;

-- And with the queue off, the shop still sees who is left, but customers
-- can't join and Find a barber shows no count.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  e queue_entries := add_to_queue('Uncle Lim');
begin
  perform remove_from_queue(e.id);
  reset role;
  assert (select gone_reason from queue_entries where id = e.id) = 'removed', 'taken off: ' || e::text;
  set role authenticated;
  perform add_to_queue('Ah Kow');
  update shops set queue_enabled = false where id = '00000000-0000-0000-0000-00000000005a';
  assert (select array_agg(name) from shop_queue()) = array['Ah Kow'], 'Ah Kow is still on the list';
  assert (select queue_waiting from find_shops() where id = '00000000-0000-0000-0000-00000000005a') is null,
    'no count with the queue off';
  assert queue_status('00000000-0000-0000-0000-00000000005a')->>'open' = 'false', 'not open';
end $$;

-- Booking a time here later today, or moving one into today, leaves the
-- queue: the time is their turn (see join_queue). Past closing time, or
-- with a barber back from a break a minute early, the shop still starts the
-- cuts of those left, with anyone working today but not someone off. In a
-- zone where it is now just past noon, so there are times left today
-- whenever the test runs; Ali works the morning and Danial from noon.
reset role;
delete from bookings where shop_id = '00000000-0000-0000-0000-00000000005a';
-- In that zone, Kajang's yesterday may be today.
delete from queue_entries where id = current_setting('test.yesterday')::uuid;
update shops set queue_enabled = true where id = '00000000-0000-0000-0000-00000000005a';
do $$
declare
  tz text;
begin
  select z into tz
  from generate_series(-12, 14) o,
       lateral (select 'Etc/GMT' || case when o > 0 then '-' || o when o < 0 then '+' || -o else '' end as z) n
  where extract(hour from now() at time zone z) = 12
  order by o
  limit 1;
  update shops set time_zone = tz where id = '00000000-0000-0000-0000-00000000005a';
  perform set_config('test.tz', tz, false);
end $$;
delete from working_hours
where barber_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a1'::uuid, d, '09:00'::time, '12:00'::time from generate_series(0, 6) d
union all
select '00000000-0000-0000-0000-0000000000a2', d, '12:00', '20:00' from generate_series(0, 6) d;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$
declare
  tz text := current_setting('test.tz');
  today date := (now() at time zone current_setting('test.tz'))::date;
  e queue_entries := join_queue('00000000-0000-0000-0000-0000000000e1');
  b bookings;
begin
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (today + time '17:00') at time zone tz);
  assert my_queue() = '[]' and queue_status('00000000-0000-0000-0000-00000000005a')->'mine' = 'null',
    'Hakim booked 5 pm today, so he is out of the queue';
  reset role;
  select * into e from queue_entries where id = e.id;
  assert e.state = 'gone' and e.gone_reason = 'left' and e.gone_at = now(), 'he left it: ' || e::text;
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c7';
do $$
declare
  tz text := current_setting('test.tz');
  today date := (now() at time zone current_setting('test.tz'))::date;
  e queue_entries;
  b bookings;
begin
  -- A time tomorrow doesn't count, until she moves it to today.
  b := book_appointment('00000000-0000-0000-0000-0000000000e1', (today + 1 + time '15:00') at time zone tz);
  e := join_queue('00000000-0000-0000-0000-0000000000e1');
  assert my_queue()->0->>'state' = 'waiting', 'Siti waits with a booking tomorrow';
  b := reschedule_booking(b.id, (today + time '16:00') at time zone tz);
  assert my_queue() = '[]', 'moved to 4 pm today, she is out of the queue';
  reset role;
  assert (select gone_reason from queue_entries where id = e.id) = 'left', 'she left it';
end $$;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  e queue_entries := add_to_queue('Pak Mat', null, '00000000-0000-0000-0000-0000000000e1');
  b bookings;
begin
  assert queue_status('00000000-0000-0000-0000-00000000005a')->>'barbers_in' = '1', 'only Danial is in';
  b := start_from_queue(e.id, '00000000-0000-0000-0000-0000000000a1');
  assert b.barber_id = '00000000-0000-0000-0000-0000000000a1' and b.starts_at = date_trunc('minute', now())
     and b.guest_name = 'Pak Mat', 'Ali finished at noon, but takes Pak Mat: ' || b::text;
end $$;
reset role;
delete from working_hours
where barber_id = '00000000-0000-0000-0000-0000000000a2'
  and weekday = extract(dow from (now() at time zone current_setting('test.tz'))::date);
set role authenticated;
do $$
declare
  e queue_entries := add_to_queue('Pak Su', null, '00000000-0000-0000-0000-0000000000e1');
begin
  perform start_from_queue(e.id, '00000000-0000-0000-0000-0000000000a2');
  raise exception 'a barber not working today should be refused';
exception when sqlstate 'P0001' then
  assert sqlerrm = 'That barber isn''t working today. Pick another barber.', sqlerrm;
end $$;

-- Deleting an account takes its places with it.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c6';
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert not exists (select 1 from queue_entries where customer_id = '00000000-0000-0000-0000-0000000000c6'),
    'a deleted account waits for nothing';
end $$;
rollback;

-- Whole screens in one request ------------------------------------------------------
-- The shop's page (shop_page) and the barber's day (shop_day) each come in one
-- answer, part for part what the requests they replace give the same caller:
-- the selects under row-level security as the app sent them, and the
-- functions. A diary with something in every part: an away barber and a
-- hidden service, a closure, a barber's day off, five reviews, a waiting
-- list, a walk-in queue, notes and numbers. Ali works all day every day, so
-- the queue is open at any hour. Hakim and Siti are customers, and Rahman
-- owns another shop, for this part only.
begin;
reset role;
delete from bookings;
delete from shop_closures;
delete from waitlist;
delete from queue_entries;
delete from working_hours
where barber_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2');
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a1', d, '00:00', '24:00' from generate_series(0, 6) d;
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select '00000000-0000-0000-0000-0000000000a2', d, r.opens, r.closes
from generate_series(1, 5) d, (values ('09:00'::time, '12:00'::time), ('13:00', '18:00')) r (opens, closes);
update barbers set is_active = true, sort_order = 0, about = null where shop_id = '00000000-0000-0000-0000-00000000005a';
update barbers set about = 'Skin fades and beard trims' where id = '00000000-0000-0000-0000-0000000000a2';
update shops set is_published = true, subscription_status = 'active', queue_enabled = true
where id = '00000000-0000-0000-0000-00000000005a';
update services set is_active = true where shop_id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000001c1', 'hakim.p@test', '{"role":"customer","full_name":"Hakim bin Omar","phone":"011-2233 4455"}'),
  ('00000000-0000-0000-0000-0000000001c2', 'siti.p@test', '{"role":"customer","full_name":"Siti Aminah","phone":"019-555 1234"}'),
  ('00000000-0000-0000-0000-0000000001b1', 'rahman.p@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug, is_published) values
  ('00000000-0000-0000-0000-00000000015b', '00000000-0000-0000-0000-0000000001b1', 'Kemas Cuts', 'kemas-cuts', true);
insert into barbers (id, shop_id, name, is_active, sort_order) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-00000000015b', 'Rahman', true, 0),
  ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-00000000005a', 'Zul', false, 5);
insert into working_hours (barber_id, weekday, opens_at, closes_at)
select b, d, '10:00', '18:00'
from unnest(array['00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000001a2']::uuid[]) b,
     generate_series(0, 6) d;
insert into services (id, shop_id, name, duration_min, price, sort_order, is_active) values
  ('00000000-0000-0000-0000-0000000001e1', '00000000-0000-0000-0000-00000000005a', 'Skin fade', 45, 35, 1, true),
  ('00000000-0000-0000-0000-0000000001e2', '00000000-0000-0000-0000-00000000005a', 'Old style', 30, 20, 2, false),
  ('00000000-0000-0000-0000-0000000001e3', '00000000-0000-0000-0000-00000000015b', 'Fade', 45, 30, 0, true);
-- Photos of the shop's cuts: one Danial's moved first, one not named, and two at the same place in the order.
insert into shop_photos (shop_id, barber_id, caption, path, thumb_path, width, height, sort_order, created_at)
select '00000000-0000-0000-0000-00000000005a', b, c, '00000000-0000-0000-0000-00000000005a/' || n || '.jpg',
       '00000000-0000-0000-0000-00000000005a/' || n || '-thumb.jpg', 1200, 1600, 0, now() - n * interval '1 day'
from (values (1, '00000000-0000-0000-0000-0000000000a1'::uuid, 'Hard part'),
             (2, '00000000-0000-0000-0000-0000000000a2', null),
             (3, null, 'Kids cut'),
             (4, '00000000-0000-0000-0000-0000000000a1', null)) x (n, b, c);
-- A new photo goes last; the owner's order is set after.
update shop_photos set sort_order = case split_part(path, '/', 2) when '1.jpg' then 2 when '2.jpg' then -1 when '3.jpg' then 2 else 0 end
where shop_id = '00000000-0000-0000-0000-00000000005a';
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  at_ time := '10:00';
  shop uuid := '00000000-0000-0000-0000-00000000005a';
  ali uuid := '00000000-0000-0000-0000-0000000000a1';
  danial uuid := '00000000-0000-0000-0000-0000000000a2';
  ben uuid := '00000000-0000-0000-0000-0000000000c1';
  hakim uuid := '00000000-0000-0000-0000-0000000001c1';
  siti uuid := '00000000-0000-0000-0000-0000000001c2';
  haircut uuid := '00000000-0000-0000-0000-0000000000e1';
  local_ timestamptz;
  b bookings;
begin
  update profiles set phone = '012-777 8888' where id = ben;
  -- Five finished cuts over the last weeks, each reviewed: the page shows three, and there are more.
  for n in 1..5 loop
    local_ := (today - 7 * n + at_)::timestamp at time zone 'Asia/Kuala_Lumpur';
    insert into bookings (shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at, status)
    values (shop, case when n % 2 = 0 then danial else ali end, haircut, case when n % 2 = 0 then hakim else ben end,
            'Haircut', 25, local_, local_ + interval '30 minutes', 'completed')
    returning * into b;
    insert into reviews (booking_id, shop_id, barber_id, customer_id, rating, comment, first_name, reply, replied_at, created_at)
    values (b.id, shop, b.barber_id, b.customer_id, 3 + n % 3, case when n <> 3 then 'Kemas ' || n end,
            case when n % 2 = 0 then 'Hakim' else 'Ben' end, case when n = 1 then 'Terima kasih' end,
            case when n = 1 then now() end, b.ends_at + interval '1 hour');
  end loop;
  -- Today: Ben's online cut with a note, a walk-in with a number, Danial's break, and one Siti cancelled.
  insert into bookings (shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at,
                        customer_note, customer_changed_at, customer_change)
  values (shop, ali, haircut, ben, 'Haircut', 25, (today + time '10:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + time '10:30')::timestamp at time zone 'Asia/Kuala_Lumpur', 'Low fade, keep the top long',
          now() - interval '2 hours', 'booked');
  insert into bookings (shop_id, barber_id, service_id, guest_name, guest_phone, service_name, price, starts_at, ends_at)
  values (shop, danial, haircut, 'Pak Mat', '013-999 0000', 'Haircut', 25,
          (today + time '11:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + time '11:30')::timestamp at time zone 'Asia/Kuala_Lumpur');
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  values (shop, danial, true, 'Lunch', 0, (today + time '12:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + time '13:00')::timestamp at time zone 'Asia/Kuala_Lumpur');
  insert into bookings (shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at, status,
                        customer_changed_at, customer_change)
  values (shop, ali, haircut, siti, 'Haircut', 25, (today + 2 + time '15:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + 2 + time '15:30')::timestamp at time zone 'Asia/Kuala_Lumpur', 'cancelled',
          now() - interval '1 hour', 'cancelled');
  -- Tomorrow: Ben still to remind, Siti reminded, and a walk-in with a number still to remind.
  insert into bookings (shop_id, barber_id, service_id, customer_id, service_name, price, starts_at, ends_at, reminded_at)
  values (shop, ali, haircut, ben, 'Haircut', 25, (today + 1 + time '10:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + 1 + time '10:30')::timestamp at time zone 'Asia/Kuala_Lumpur', null),
         (shop, danial, haircut, siti, 'Haircut', 25, (today + 1 + time '10:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + 1 + time '10:30')::timestamp at time zone 'Asia/Kuala_Lumpur', now());
  insert into bookings (shop_id, barber_id, service_id, guest_name, guest_phone, service_name, price, starts_at, ends_at)
  values (shop, ali, haircut, 'Pak Long', '017-123 4567', 'Haircut', 25,
          (today + 1 + time '11:00')::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + 1 + time '11:30')::timestamp at time zone 'Asia/Kuala_Lumpur');
  -- Danial's whole day off in three days, and the shop closed in five, each with a reason only the owner sees.
  insert into bookings (shop_id, barber_id, is_block, service_name, price, starts_at, ends_at)
  values (shop, danial, true, 'Kenduri', 0, (today + 3)::timestamp at time zone 'Asia/Kuala_Lumpur',
          (today + 4)::timestamp at time zone 'Asia/Kuala_Lumpur');
  insert into shop_closures (shop_id, day, reason) values (shop, today + 5, 'Hari Raya'), (shop, today + 30, 'Cuti');
  -- Waiting for a time two days out, and today's queue: Hakim online, a walk-in with a number, one gone.
  insert into waitlist (shop_id, customer_id, day, service_id, barber_id, created_at) values
    (shop, hakim, today + 2, haircut, null, now() - interval '3 hours'),
    (shop, ben, today + 2, '00000000-0000-0000-0000-0000000001e1', danial, now() - interval '2 hours');
  insert into queue_entries (shop_id, day, customer_id, service_id, created_at) values
    (shop, today, hakim, haircut, now() - interval '20 minutes');
  insert into queue_entries (shop_id, day, guest_name, guest_phone, barber_id, created_at) values
    (shop, today, 'Pak Su', '016-444 5555', ali, now() - interval '10 minutes');
  insert into queue_entries (shop_id, day, customer_id, state, gone_reason, gone_at, created_at) values
    (shop, today, siti, 'gone', 'left', now() - interval '5 minutes', now() - interval '30 minutes');
end $$;

-- What the shop's page asked for before, one request each, as the caller.
-- Security invoker, so row-level security decides what each select sees.
create function public.test_shop_requests(p_slug text)
returns jsonb
language plpgsql
as $$
declare
  s shops;
  today date;
  page jsonb;
begin
  select * into s from shops where slug = p_slug;
  if not found then
    return jsonb_build_object('shop', null, 'status', (select to_jsonb(x) from shop_public_status(p_slug) x));
  end if;
  today := (now() at time zone s.time_zone)::date;
  select coalesce(jsonb_agg(jsonb_build_object(
           'booking_id', r.booking_id, 'rating', r.rating, 'comment', r.comment, 'first_name', r.first_name,
           'reply', r.reply, 'replied_at', r.replied_at, 'created_at', r.created_at,
           'barbers', (select jsonb_build_object('name', b.name) from barbers b where b.id = r.barber_id))
         order by r.created_at desc, r.booking_id), '[]')
    into page
  from (select r.booking_id, r.rating, r.comment, r.first_name, r.reply, r.replied_at, r.created_at, r.barber_id
        from reviews r where r.shop_id = s.id order by r.created_at desc, r.booking_id limit 4) r;
  return jsonb_build_object(
    'shop', to_jsonb(s),
    'services', coalesce((select jsonb_agg(to_jsonb(v) order by v.sort_order, v.name, v.id)
                          from services v where v.shop_id = s.id and v.is_active), '[]'),
    'barbers', coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object('working_hours', coalesce((
               select jsonb_agg(jsonb_build_object('weekday', wh.weekday, 'opens_at', wh.opens_at, 'closes_at', wh.closes_at)
                                order by wh.weekday, wh.opens_at)
               from working_hours wh where wh.barber_id = b.id), '[]')) order by b.sort_order, b.name, b.id)
      from barbers b where b.shop_id = s.id and b.is_active), '[]'),
    'today', today,
    'closed_days', coalesce((select jsonb_agg(to_jsonb(d)) from shop_closed_days(s.id, today, today + 13) d), '[]'),
    'hours_today', (select to_jsonb(h) from shop_hours_today(s.id) h),
    'queue', case when s.queue_enabled then queue_status(s.id) end,
    'photos', coalesce((select jsonb_agg(to_jsonb(ph) - 'created_at' order by ph.sort_order, ph.created_at, ph.id)
                        from (select ph.id, ph.barber_id, ph.caption, ph.path, ph.thumb_path, ph.width, ph.height,
                                     ph.sort_order, ph.created_at
                              from shop_photos ph where ph.shop_id = s.id
                              order by ph.sort_order, ph.created_at, ph.id limit 24) ph), '[]'),
    'reviews', coalesce(jsonb_path_query_array(page, '$[0 to 2]'), '[]'),
    'more_reviews', jsonb_array_length(page) > 3);
end;
$$;

-- What the Bookings tab asked for on a day before, one request each, as the owner.
create function public.test_day_requests(p_day date, p_since timestamptz default null)
returns jsonb
language plpgsql
as $$
declare
  s shops;
  today date;
begin
  select * into s from shops where owner_id = auth.uid();
  today := (now() at time zone s.time_zone)::date;
  return jsonb_build_object(
    'bookings', coalesce((
      select jsonb_agg(to_jsonb(b) || jsonb_build_object(
               'barbers', (select jsonb_build_object('name', br.name) from barbers br where br.id = b.barber_id),
               'customer', (select jsonb_build_object('full_name', p.full_name, 'phone', p.phone)
                            from profiles p where p.id = b.customer_id)) order by b.starts_at, b.id)
      from bookings b
      where b.shop_id = s.id
        and b.starts_at >= p_day::timestamp at time zone s.time_zone
        and b.starts_at < (p_day + 1)::timestamp at time zone s.time_zone), '[]'),
    'services', (select count(*) from services v where v.shop_id = s.id and v.is_active),
    'barbers', coalesce((
      select jsonb_agg(to_jsonb(br) || jsonb_build_object('working_hours', coalesce((
               select jsonb_agg(to_jsonb(wh) order by wh.weekday, wh.opens_at)
               from working_hours wh where wh.barber_id = br.id), '[]')) order by br.sort_order, br.created_at, br.id)
      from barbers br where br.shop_id = s.id), '[]'),
    'closed', coalesce((select jsonb_agg(to_jsonb(d))
                        from shop_closed_days(s.id, least(p_day, today - 1), greatest(p_day, today + 13)) d), '[]'),
    'tomorrow', case when p_day = today then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'barber_id', b.barber_id, 'status', b.status, 'is_block', b.is_block, 'starts_at', b.starts_at,
               'reminded_at', b.reminded_at, 'guest_phone', b.guest_phone, 'created_at', b.created_at,
               'customer', (select jsonb_build_object('phone', p.phone) from profiles p where p.id = b.customer_id))
             order by b.starts_at, b.id)
      from bookings b
      where b.shop_id = s.id and b.status = 'confirmed' and not b.is_block and b.reminded_at is null
        and b.starts_at >= (today + 1)::timestamp at time zone s.time_zone
        and b.starts_at < (today + 2)::timestamp at time zone s.time_zone), '[]') else '[]' end,
    'waiting', coalesce((select jsonb_agg(to_jsonb(w)) from shop_waitlist(p_day) w), '[]'),
    'queue', case when p_day = today then coalesce((select jsonb_agg(to_jsonb(q)) from shop_queue() q), '[]') else '[]' end,
    'changes', shop_changes(p_since, 5));
end;
$$;

-- Each part the same as before, for a guest, a customer in the queue and the owner.
set role anon;
do $$
declare
  p jsonb := shop_page('ali-cuts');
  before jsonb := test_shop_requests('ali-cuts');
  part text;
begin
  for part in select jsonb_object_keys(before) loop
    assert p -> part = before -> part, format('a guest''s %s: %s, not %s', part, p -> part, before -> part);
  end loop;
  assert (select array_agg(k order by k) from jsonb_object_keys(p) k) = (select array_agg(k order by k) from jsonb_object_keys(before) k),
    'the same parts: ' || p::text;
  -- What the page needs is all there.
  assert p #>> '{shop,name}' = 'Ali Cuts' and p -> 'status' is null, 'the shop: ' || (p -> 'shop')::text;
  assert (select array_agg(s ->> 'name') from jsonb_array_elements(p -> 'services') s) = array['Haircut', 'Skin fade'],
    'active services in order: ' || (p -> 'services')::text;
  assert (select array_agg(b ->> 'name') from jsonb_array_elements(p -> 'barbers') b) = array['Ali', 'Danial'],
    'active barbers only: ' || (p -> 'barbers')::text;
  assert jsonb_array_length(p #> '{barbers,1,working_hours}') = 10 and p #>> '{barbers,1,about}' = 'Skin fades and beard trims'
     and (p #>> '{barbers,0,rating_count}')::int = 3, 'each barber with hours, line and stars: ' || (p -> 'barbers')::text;
  assert jsonb_array_length(p -> 'reviews') = 3 and p -> 'more_reviews' = 'true'
     and p #>> '{reviews,0,first_name}' = 'Ben' and p #>> '{reviews,0,barbers,name}' = 'Ali'
     and p #>> '{reviews,0,reply}' = 'Terima kasih', 'the newest three reviews, and more: ' || (p -> 'reviews')::text;
  assert jsonb_array_length(p -> 'closed_days') = 2, 'Danial''s day off and the closure: ' || (p -> 'closed_days')::text;
  assert (select array_agg(split_part(ph ->> 'path', '/', 2)) from jsonb_array_elements(p -> 'photos') ph)
           = array['2.jpg', '4.jpg', '3.jpg', '1.jpg']
     and p #>> '{photos,0,barber_id}' = '00000000-0000-0000-0000-0000000000a2' and p #> '{photos,0,caption}' = 'null'
     and p #>> '{photos,3,caption}' = 'Hard part', 'the photos in the owner''s order: ' || (p -> 'photos')::text;
  assert (p #>> '{queue,waiting}')::int = 2 and p #> '{queue,mine}' = 'null', 'two waiting, and none of them a guest';
  -- And nothing private: no customer's number, note, account or full name, nobody in the queue,
  -- and no reason for a day off.
  for part in select unnest(array['012-777 8888', '011-2233 4455', '019-555 1234', 'Low fade', 'Pak Mat', 'Pak Su',
                                  '016-444 5555', 'Hakim bin Omar', 'Siti', 'Kenduri', 'Hari Raya', 'customer_id',
                                  '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000001c1']) loop
    assert strpos(p::text, part) = 0, format('a guest must not see %s: %s', part, p);
  end loop;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000001c1';
do $$
declare
  p jsonb := shop_page('ali-cuts');
  before jsonb := test_shop_requests('ali-cuts');
  part text;
begin
  for part in select jsonb_object_keys(before) loop
    assert p -> part = before -> part, format('a customer''s %s: %s, not %s', part, p -> part, before -> part);
  end loop;
  assert (p #>> '{queue,mine,place}')::int = 1 and p #>> '{queue,mine,state}' = 'waiting',
    'Hakim sees his own place: ' || (p -> 'queue')::text;
  for part in select unnest(array['012-777 8888', '019-555 1234', 'Low fade', 'Pak Mat', 'Pak Su', '016-444 5555',
                                  'Siti', 'Kenduri', 'Hari Raya', 'customer_id']) loop
    assert strpos(p::text, part) = 0, format('a customer must not see %s: %s', part, p);
  end loop;
end $$;
-- The owner sees the reasons for the days off, as shop_closed_days gives them to the owner.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  p jsonb := shop_page('ali-cuts');
  before jsonb := test_shop_requests('ali-cuts');
  part text;
begin
  for part in select jsonb_object_keys(before) loop
    assert p -> part = before -> part, format('the owner''s %s: %s, not %s', part, p -> part, before -> part);
  end loop;
  assert strpos(p::text, 'Kenduri') > 0 and strpos(p::text, 'Hari Raya') > 0, 'the owner''s reasons: ' || (p -> 'closed_days')::text;
end $$;
-- A shop with no queue sends none, and its reviews are none yet.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000001c1';
do $$
declare
  p jsonb := shop_page('kemas-cuts');
begin
  assert p = test_shop_requests('kemas-cuts'), 'Kemas Cuts as before: ' || p::text;
  assert p -> 'queue' = 'null' and p -> 'reviews' = '[]' and p -> 'more_reviews' = 'false', 'no queue, no reviews: ' || p::text;
end $$;

-- Hidden: the page only learns whose shop it is, the way shop_public_status says, and an unknown link nothing.
reset role;
update shops set is_published = false where id = '00000000-0000-0000-0000-00000000005a';
set role anon;
do $$
declare
  p jsonb := shop_page('ali-cuts');
begin
  assert p = jsonb_build_object('shop', null, 'status',
               jsonb_build_object('name', 'Ali Cuts', 'phone', '012-345 6789', 'is_live', false)), 'paused: ' || p::text;
  assert p = test_shop_requests('ali-cuts'), 'as shop_public_status says';
  assert shop_page('no-such-shop') = '{"shop": null, "status": null}', 'an unknown link: ' || shop_page('no-such-shop')::text;
  assert test_shop_requests('no-such-shop') = '{"shop": null, "status": null}', 'as before';
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000001c1';
do $$ begin
  assert shop_page('ali-cuts') = test_shop_requests('ali-cuts') and shop_page('ali-cuts') -> 'shop' = 'null',
    'a customer sees it paused too';
end $$;
-- Its owner still sees their own page, as the shops policy lets them.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  p jsonb := shop_page('ali-cuts');
begin
  assert p = test_shop_requests('ali-cuts') and p #>> '{shop,name}' = 'Ali Cuts', 'the owner''s paused shop: ' || p::text;
  assert p #> '{queue,open}' = 'false', 'with its queue shut while paused';
end $$;
reset role;
update shops set is_published = true where id = '00000000-0000-0000-0000-00000000005a';

-- The barber's day: every part as the separate requests gave the owner, on
-- each day the strip shows that has something, a day gone by and one off it.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  d date;
  got jsonb;
  before jsonb;
  part text;
begin
  foreach d in array array[today - 7, today - 1, today, today + 1, today + 2, today + 3, today + 5, today + 30] loop
    got := shop_day(d);
    before := test_day_requests(d);
    for part in select jsonb_object_keys(before) loop
      assert got -> part = before -> part, format('%s''s %s: %s, not %s', d, part, got -> part, before -> part);
    end loop;
    assert (select count(*) from jsonb_object_keys(got)) = (select count(*) from jsonb_object_keys(before)),
      'the same parts: ' || got::text;
  end loop;
  got := shop_day(today);
  assert jsonb_array_length(got -> 'bookings') = 3, 'today''s three: ' || (got -> 'bookings')::text;
  assert (select count(*) from jsonb_array_elements(got -> 'bookings') b
          where b #>> '{customer,full_name}' = 'Ben' and b #>> '{customer,phone}' = '012-777 8888'
            and b ->> 'customer_note' = 'Low fade, keep the top long' and b #>> '{barbers,name}' = 'Ali') = 1,
    'Ben''s booking with his name, number and note';
  assert (select array_agg(b ->> 'name' order by b ->> 'name') from jsonb_array_elements(got -> 'barbers') b)
         = array['Ali', 'Danial', 'Zul'], 'every barber, away ones too: ' || (got -> 'barbers')::text;
  assert (got ->> 'services')::int = 2, 'two services customers can book';
  assert (select array_agg(b ->> 'guest_phone' order by b ->> 'starts_at') from jsonb_array_elements(got -> 'tomorrow') b)
         = array[null, '017-123 4567'], 'tomorrow''s two still to remind: ' || (got -> 'tomorrow')::text;
  assert (select array_agg(q ->> 'name' order by q ->> 'created_at') from jsonb_array_elements(got -> 'queue') q)
         = array['Hakim bin Omar', 'Pak Su'], 'today''s queue in order: ' || (got -> 'queue')::text;
  assert (got #>> '{changes,count}')::int = 2, 'Ben''s booking and Siti''s cancellation: ' || (got -> 'changes')::text;
  assert (select count(*) from jsonb_array_elements(got -> 'closed') c where c ->> 'reason' = 'Hari Raya') = 1
     and (select count(*) from jsonb_array_elements(got -> 'closed') c where c ->> 'reason' = 'Kenduri') = 1,
    'the strip''s closed days with reasons: ' || (got -> 'closed')::text;
  got := shop_day(today + 2);
  assert jsonb_array_length(got -> 'waiting') = 2 and got -> 'queue' = '[]' and got -> 'tomorrow' = '[]',
    'two waiting in two days, and no queue or reminders but today''s: ' || got::text;
  assert shop_day(today + 30) -> 'closed' @> jsonb_build_array(jsonb_build_object('day', today + 30, 'reason', 'Cuti')),
    'a day off the strip is asked for too: ' || (shop_day(today + 30) -> 'closed')::text;
  -- What customers changed since a time, and how many lines, as shop_changes takes them.
  assert shop_day(today, now() - interval '90 minutes', 1) -> 'changes' = shop_changes(now() - interval '90 minutes', 1),
    'since a time: ' || (shop_day(today, now() - interval '90 minutes', 1) -> 'changes')::text;
  assert (shop_day(today, now() - interval '90 minutes', 1) #>> '{changes,count}')::int = 1, 'only Siti''s since then';
  assert shop_day(today, null, 1) -> 'changes' = test_day_requests(today) -> 'changes' #- '{changes,1}',
    'one line of two';
end $$;
-- With the queue off and nobody in it, today has no queue; turned off with people still in it, they still show.
reset role;
update shops set queue_enabled = false where id = '00000000-0000-0000-0000-00000000005a';
set role authenticated;
do $$ begin
  assert jsonb_array_length(shop_day((now() at time zone 'Asia/Kuala_Lumpur')::date) -> 'queue') = 2,
    'turned off with two still in it';
end $$;
reset role;
update queue_entries set state = 'gone', gone_reason = 'served', gone_at = now() where shop_id = '00000000-0000-0000-0000-00000000005a';
set role authenticated;
do $$ begin
  assert shop_day((now() at time zone 'Asia/Kuala_Lumpur')::date) -> 'queue' = '[]', 'off and empty';
end $$;

-- Another owner gets their own shop's day and nothing of Ali's; a customer has no day, and guests can't ask.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000001b1';
do $$
declare
  today date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  got jsonb;
  part text;
begin
  foreach part in array array['-1', '0', '1', '2', '3', '5'] loop
    got := shop_day(today + part::int);
    assert got = test_day_requests(today + part::int), 'Rahman''s own day: ' || got::text;
    assert got -> 'bookings' = '[]' and got -> 'waiting' = '[]' and got -> 'queue' = '[]' and got -> 'closed' = '[]'
       and got #>> '{changes,count}' = '0' and got -> 'tomorrow' = '[]', 'nothing of Ali''s: ' || got::text;
    assert (select array_agg(b ->> 'name') from jsonb_array_elements(got -> 'barbers') b) = array['Rahman'],
      'only his own barber';
    for part in select unnest(array['Ben', 'Hakim', 'Siti', 'Pak', 'Ali', 'Danial', '00000000-0000-0000-0000-00000000005a']) loop
      assert strpos(got::text, part) = 0, format('Rahman must not see %s: %s', part, got);
    end loop;
    part := '0';
  end loop;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform shop_day(current_date);
  raise exception 'customers have no day to see';
exception when sqlstate 'P0002' then
  assert sqlerrm = 'Set up your shop first.', 'unexpected message: ' || sqlerrm;
end $$;
reset role;
set role anon;
do $$ begin
  perform shop_day(current_date);
  raise exception 'guests must not call shop_day';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;

-- Photos of the shop's cuts -----------------------------------------------------
-- The owner puts each photo and its thumbnail in the shop's folder of the
-- shop-photos bucket, then lists it with who did the cut and a caption.
-- Anyone sees a live shop's photos, first first; only the owner writes them,
-- and a shop keeps at most 24. Rahman owns a second shop for this part only.
begin;
reset role;
update shops set is_published = true, subscription_status = 'active' where id = '00000000-0000-0000-0000-00000000005a';
update barbers set is_active = true where shop_id = '00000000-0000-0000-0000-00000000005a';
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000b2', 'owner2@test', '{"role":"barber","full_name":"Rahman"}');
insert into shops (id, owner_id, name, slug) values
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000b2', 'Kemas Cuts', 'kemas-cuts');
insert into barbers (id, shop_id, name) values
  ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005b', 'Rahman'),
  ('00000000-0000-0000-0000-0000000000a6', '00000000-0000-0000-0000-00000000005a', 'Faiz');
select set_config('test.shop', '00000000-0000-0000-0000-00000000005a', false) \g /dev/null

do $$ begin
  assert (select public and file_size_limit = 2 * 1024 * 1024
                 and allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
          from storage.buckets where id = 'shop-photos'),
    'a public bucket for photos: raster images up to 2 MB';
end $$;

-- The files: only into the owner's own shop folder.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
insert into storage.objects (bucket_id, name)
select 'shop-photos', current_setting('test.shop') || '/' || n
from unnest(array['cut1.jpg', 'cut1-thumb.jpg', 'cut2.jpg', 'cut2-thumb.jpg']) n;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('shop-photos', '00000000-0000-0000-0000-00000000005b/cut.jpg');
  raise exception 'an owner should not write into another shop''s folder';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('shop-photos', 'cut.jpg');
  raise exception 'files go in a shop''s folder, not loose in the bucket';
exception when insufficient_privilege then null;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  insert into storage.objects (bucket_id, name) values ('shop-photos', current_setting('test.shop') || '/mine.jpg');
  raise exception 'a customer should not add files';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  assert (select count(*) from storage.objects) = 0, 'customers don''t list the files: they come from the CDN';
end $$;
set role anon;
do $$ begin
  insert into storage.objects (bucket_id, name) values ('shop-photos', current_setting('test.shop') || '/guest.jpg');
  raise exception 'a guest should not add files';
exception when insufficient_privilege then null;
end $$;

-- The photos, each going last.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
insert into shop_photos (shop_id, barber_id, caption, path, thumb_path, width, height)
values (current_setting('test.shop')::uuid, '00000000-0000-0000-0000-0000000000a1', 'Skin fade, hard part',
        current_setting('test.shop') || '/cut1.jpg', current_setting('test.shop') || '/cut1-thumb.jpg', 1200, 1600);
insert into shop_photos (shop_id, path, thumb_path, width, height)
values (current_setting('test.shop')::uuid, current_setting('test.shop') || '/cut2.jpg',
        current_setting('test.shop') || '/cut2-thumb.jpg', 1600, 1200);
do $$
declare
  shop text := current_setting('test.shop');
begin
  assert (select array_agg(caption order by sort_order) from shop_photos) = array['Skin fade, hard part', null],
    'the second photo goes after the first';
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height, sort_order)
    values (shop::uuid, shop || '/a.jpg', shop || '/a-thumb.jpg', 100, 100, -5);
    raise exception 'a new photo''s place is the database''s to give';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, '00000000-0000-0000-0000-00000000005b/a.jpg', shop || '/a-thumb.jpg', 100, 100);
    raise exception 'a photo''s file is in its own shop''s folder';
  exception when check_violation then null;
  end;
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/a/b.jpg', shop || '/a-thumb.jpg', 100, 100);
    raise exception 'no folders inside the shop''s';
  exception when check_violation then null;
  end;
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/a.jpg', shop || '/a.jpg', 100, 100);
    raise exception 'the thumbnail is a file of its own';
  exception when check_violation then null;
  end;
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/a.jpg', shop || '/a-thumb.jpg', 2400, 1600);
    raise exception 'photos are at most 1600 px';
  exception when check_violation then null;
  end;
  begin
    insert into shop_photos (shop_id, caption, path, thumb_path, width, height)
    values (shop::uuid, repeat('x', 61), shop || '/a.jpg', shop || '/a-thumb.jpg', 100, 100);
    raise exception 'captions are up to 60 characters';
  exception when check_violation then null;
  end;
  begin
    update shop_photos set caption = '   ' where path = shop || '/cut1.jpg';
    raise exception 'a blank caption is no caption';
  exception when check_violation then null;
  end;
  begin
    update shop_photos set caption = E'Fade\nwith beard' where path = shop || '/cut1.jpg';
    raise exception 'a caption is one line';
  exception when check_violation then null;
  end;
  begin
    insert into shop_photos (shop_id, barber_id, path, thumb_path, width, height)
    values (shop::uuid, '00000000-0000-0000-0000-0000000000a3', shop || '/a.jpg', shop || '/a-thumb.jpg', 100, 100);
    raise exception 'a photo''s barber works at its shop';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  begin
    update shop_photos set barber_id = '00000000-0000-0000-0000-0000000000a3' where path = shop || '/cut1.jpg';
    raise exception 'nor can one be moved to another shop''s barber';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Barber not found.', sqlerrm;
  end;
  begin
    update shop_photos set path = shop || '/other.jpg' where path = shop || '/cut1.jpg';
    raise exception 'a photo''s file never changes';
  exception when insufficient_privilege then null;
  end;
  begin
    update shop_photos set shop_id = '00000000-0000-0000-0000-00000000005b';
    raise exception 'nor its shop';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Customers and guests see a live shop's photos in order, and nothing of a hidden one's.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert (select array_agg(width order by sort_order, created_at, id) from shop_photos
          where shop_id = current_setting('test.shop')::uuid) = array[1200, 1600],
    'a customer sees the shop''s photos, first first';
  assert (select photo_thumb from find_shops() where id = current_setting('test.shop')::uuid)
         = current_setting('test.shop') || '/cut1-thumb.jpg',
    'Find a barber has the first photo''s thumbnail';
end $$;
set role anon;
do $$ begin
  assert (select count(*) from shop_photos) = 2, 'guests see them too';
end $$;
reset role;
update shops set is_published = false where id = current_setting('test.shop')::uuid;
set role authenticated;
do $$ begin
  assert (select count(*) from shop_photos) = 0, 'a hidden shop''s photos are not listed';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  assert (select count(*) from shop_photos) = 2, 'its owner still sees them';
end $$;
reset role;
update shops set is_published = true where id = current_setting('test.shop')::uuid;

-- Nobody else changes them: not a customer, nor another shop's owner.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$
declare
  shop text := current_setting('test.shop');
begin
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/c.jpg', shop || '/c-thumb.jpg', 100, 100);
    raise exception 'a customer should not add photos';
  exception when insufficient_privilege then null;
  end;
  update shop_photos set caption = 'Hacked';
  delete from shop_photos;
  delete from storage.objects;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
do $$
declare
  shop text := current_setting('test.shop');
begin
  assert (select count(*) from shop_photos) = 2, 'another owner sees a live shop''s photos like anyone';
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/c.jpg', shop || '/c-thumb.jpg', 100, 100);
    raise exception 'another owner should not add photos';
  exception when insufficient_privilege then null;
  end;
  update shop_photos set sort_order = -100;
  delete from shop_photos;
  delete from storage.objects;
end $$;
set role anon;
delete from shop_photos;
reset role;
do $$ begin
  assert (select count(*) from shop_photos where caption = 'Hacked' or sort_order = -100) = 0
     and (select count(*) from shop_photos) = 2 and (select count(*) from storage.objects) = 4,
    'nobody else changed or removed a photo or a file';
end $$;

-- The owner tags, captions and moves a photo to first.
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
update shop_photos set barber_id = '00000000-0000-0000-0000-0000000000a6', caption = 'Low taper'
where path = current_setting('test.shop') || '/cut2.jpg';
update shop_photos
set sort_order = (select min(sort_order) - 1 from shop_photos where shop_id = current_setting('test.shop')::uuid)
where path = current_setting('test.shop') || '/cut2.jpg';
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert (select array_agg(caption order by sort_order, created_at, id) from shop_photos)
         = array['Low taper', 'Skin fade, hard part'],
    'the photo moved to first comes first';
  assert (select photo_thumb from find_shops() where id = current_setting('test.shop')::uuid)
         = current_setting('test.shop') || '/cut2-thumb.jpg',
    'and is the one Find a barber shows';
end $$;

-- A barber who is deleted leaves their photos untagged.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
delete from barbers where id = '00000000-0000-0000-0000-0000000000a6';
do $$ begin
  assert (select barber_id is null and caption = 'Low taper' from shop_photos
          where path = current_setting('test.shop') || '/cut2.jpg'),
    'the photo stays, without its barber';
end $$;

-- 24 at most, however they come.
insert into shop_photos (shop_id, path, thumb_path, width, height)
select current_setting('test.shop')::uuid, current_setting('test.shop') || '/more' || n || '.jpg',
       current_setting('test.shop') || '/more' || n || '-thumb.jpg', 800, 800
from generate_series(1, 22) n;
do $$
declare
  shop text := current_setting('test.shop');
begin
  assert (select count(*) from shop_photos) = 24, 'up to 24';
  assert (select max(sort_order) from shop_photos) = 22, 'each new one after the last, the moved one at -1';
  begin
    insert into shop_photos (shop_id, path, thumb_path, width, height)
    values (shop::uuid, shop || '/25.jpg', shop || '/25-thumb.jpg', 800, 800);
    raise exception 'a 25th photo should be refused';
  exception when sqlstate 'P0001' then
    assert sqlerrm = 'Your shop has 24 photos, the most it can have. Remove one to add another.', sqlerrm;
  end;
  delete from shop_photos where path = shop || '/more22.jpg';
  insert into shop_photos (shop_id, path, thumb_path, width, height)
  values (shop::uuid, shop || '/25.jpg', shop || '/25-thumb.jpg', 800, 800);
  assert (select count(*) from shop_photos) = 24, 'removing one makes room';
end $$;
-- The limit is per shop: Rahman's shop starts at none.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
insert into shop_photos (shop_id, path, thumb_path, width, height)
values ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-00000000005b/first.jpg',
        '00000000-0000-0000-0000-00000000005b/first-thumb.jpg', 800, 800);
do $$ begin
  assert (select sort_order = 0 from shop_photos where shop_id = '00000000-0000-0000-0000-00000000005b'),
    'another shop''s first photo';
end $$;

-- Removing: the owner takes the row away, then the files.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
delete from shop_photos where path = current_setting('test.shop') || '/cut1.jpg';
delete from storage.objects
where name in (current_setting('test.shop') || '/cut1.jpg', current_setting('test.shop') || '/cut1-thumb.jpg');
do $$ begin
  assert (select count(*) from storage.objects) = 2, 'the owner sees and removes their own files';
end $$;

-- Files no photo points at, a day after they came, for the clean-up script;
-- only the service role may ask.
reset role;
delete from shop_photos;
delete from storage.objects;
insert into storage.objects (bucket_id, name, created_at) values
  ('shop-photos', current_setting('test.shop') || '/kept.jpg', now() - interval '3 days'),
  ('shop-photos', current_setting('test.shop') || '/kept-thumb.jpg', now() - interval '3 days'),
  ('shop-photos', current_setting('test.shop') || '/lost.jpg', now() - interval '2 days'),
  ('shop-photos', current_setting('test.shop') || '/lost-thumb.jpg', now() - interval '2 days'),
  ('shop-photos', current_setting('test.shop') || '/uploading.jpg', now() - interval '5 minutes');
insert into shop_photos (shop_id, path, thumb_path, width, height)
values (current_setting('test.shop')::uuid, current_setting('test.shop') || '/kept.jpg',
        current_setting('test.shop') || '/kept-thumb.jpg', 800, 800);
do $$ begin
  assert (select array_agg(f order by f) from shop_photo_files_left_behind() f)
         = array[current_setting('test.shop') || '/lost-thumb.jpg', current_setting('test.shop') || '/lost.jpg'],
    'only the old files no photo points at: ' || (select array_agg(f)::text from shop_photo_files_left_behind() f);
  assert (select count(*) from shop_photo_files_left_behind(1)) = 1, 'a page at a time';
end $$;
set role authenticated;
do $$ begin
  perform shop_photo_files_left_behind();
  raise exception 'owners and customers can''t list leftover files';
exception when insufficient_privilege then null;
end $$;
set role anon;
do $$ begin
  perform shop_photo_files_left_behind();
  raise exception 'guests can''t list leftover files';
exception when insufficient_privilege then null;
end $$;

-- At most 56 files in a shop's folder, whatever its photos: two for each of
-- 24 and a few on their way, so a barber can't fill the public bucket with
-- files no photo lists. Counted by folder: another shop's files, a folder
-- whose name starts the same and a loose file beside it don't count.
reset role;
delete from shop_photos;
delete from storage.objects;
insert into storage.objects (bucket_id, name)
select 'shop-photos', current_setting('test.shop') || '/old' || n || '.jpg' from generate_series(1, 55) n;
insert into storage.objects (bucket_id, name) values
  ('shop-photos', '00000000-0000-0000-0000-00000000005b/theirs.jpg'),
  ('shop-photos', current_setting('test.shop') || '0/near.jpg'),
  ('shop-photos', current_setting('test.shop') || '.jpg');
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin
  assert public.my_shop_photo_file_count() = 55, 'only the folder''s own: ' || public.my_shop_photo_file_count();
end $$;
insert into storage.objects (bucket_id, name) values ('shop-photos', current_setting('test.shop') || '/56th.jpg');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('shop-photos', current_setting('test.shop') || '/57th.jpg');
  raise exception 'a shop''s folder holds at most 56 files';
exception when insufficient_privilege then null;
end $$;
-- Removing one makes room again.
delete from storage.objects where name = current_setting('test.shop') || '/old1.jpg';
insert into storage.objects (bucket_id, name) values ('shop-photos', current_setting('test.shop') || '/57th.jpg');
-- Another shop's folder has its own count.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
insert into storage.objects (bucket_id, name) values ('shop-photos', '00000000-0000-0000-0000-00000000005b/more.jpg');
do $$ begin
  assert public.my_shop_photo_file_count() = 2, 'Rahman''s shop has two files';
end $$;
-- Someone with no shop has no folder to count.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  assert public.my_shop_photo_file_count() = 0, 'a customer has no shop folder';
end $$;
set role anon;
do $$ begin
  perform public.my_shop_photo_file_count();
  raise exception 'guests can''t count a shop''s files';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$
declare
  line text;
  plan text := '';
begin
  -- my_shop_photo_file_count()'s count: just the folder's names off the
  -- index, never every file in the bucket (seq scans off, as this test's
  -- table is too small to need the index).
  set local enable_seqscan = off;
  for line in execute 'explain select count(*) from storage.objects o where o.bucket_id = ''shop-photos''
                         and o.name collate "C" >= ''x/'' and o.name collate "C" < ''x0''' loop
    plan := plan || line || E'\n';
  end loop;
  assert plan like '%Index Only Scan using idx_objects_bucket_id_name%'
     and plan like '%Index Cond: ((bucket_id = %) AND (name >= %) AND (name < %))%',
    'reads the (bucket_id, name collate "C") index for the folder''s range: ' || plan;
end $$;
rollback;

-- Deleting an account ------------------------------------------------------
reset role;
set role anon;
do $$ begin
  perform delete_my_account();
  raise exception 'guests must not call delete_my_account';
exception when insufficient_privilege then null;
end $$;

-- The second customer still has four upcoming bookings from above.
set role authenticated;
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000c2'),
    'the account should be gone';
  assert not exists (select 1 from profiles where id = '00000000-0000-0000-0000-0000000000c2'),
    'the profile should be gone';
  assert (select count(*) from bookings where guest_name = 'Deleted account' and status = 'cancelled'
          and customer_id is null and guest_phone is null) = 4,
    'their upcoming bookings should be cancelled and kept without their details';
  assert exists (select 1 from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'),
    'other customers'' bookings are untouched';
end $$;
-- Their shop hears about those cancellations, with no name to show.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin
  assert (select count(*) from jsonb_array_elements(shop_changes(null, 20) -> 'changes') e
          where e ->> 'customer_name' = 'Deleted account' and e ->> 'change' = 'cancelled') = 4,
    'a deleted account''s upcoming bookings show as cancelled: ' || shop_changes(null, 20)::text;
end $$;
reset role;

-- The owner deletes their account: the shop and everything in it goes,
-- its walk-in queue too, with the places its bookings served, and its photos.
insert into queue_entries (shop_id, day, guest_name, state, gone_reason, gone_at, booking_id)
select shop_id, (starts_at at time zone 'Asia/Kuala_Lumpur')::date, 'Walked in', 'gone', 'served', starts_at, id
from bookings
where shop_id = '00000000-0000-0000-0000-00000000005a' and not is_block;
insert into queue_entries (shop_id, day, guest_name)
values ('00000000-0000-0000-0000-00000000005a', (now() at time zone 'Asia/Kuala_Lumpur')::date, 'Still waiting');
insert into shop_photos (shop_id, path, thumb_path, width, height)
values ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-00000000005a/last.jpg',
        '00000000-0000-0000-0000-00000000005a/last-thumb.jpg', 1200, 900);
do $$ begin
  assert (select count(*) from queue_entries where booking_id is not null) > 0, 'served places to delete';
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert (select count(*) from shops) = 0, 'the shop should be gone';
  assert (select count(*) from barbers) = 0 and (select count(*) from services) = 0
     and (select count(*) from working_hours) = 0 and (select count(*) from bookings) = 0
     and (select count(*) from queue_entries) = 0 and (select count(*) from shop_photos) = 0,
    'everything in the shop should be gone';
  assert exists (select 1 from profiles where id = '00000000-0000-0000-0000-0000000000c1'),
    'customers keep their accounts';
end $$;

reset role;
\echo 'All booking tests passed.'
