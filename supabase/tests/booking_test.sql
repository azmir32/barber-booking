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
  assert shop_next_free(shop) is null, 'a hidden shop has no free time';
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
    perform shop_next_free(shop);
    raise exception 'only find_shops should call shop_next_free';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- shop_next_free takes a shortcut, so check it against available_slots on a
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
    assert shop_next_free(shop) is not distinct from want,
      format('at %s:00 next free should be %s, got %s', hour, want, shop_next_free(shop));
    k := k + (want is not null)::int;
  end loop;
  assert k > 12, 'most hours should have a free time to compare';
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
  -- One barber's day off doesn't close the shop.
  off := add_shop_booking('00000000-0000-0000-0000-0000000000a2', d + 1, '00:00', 1440,
    p_note => 'Day off', p_is_block => true);
  assert (select count(*) from shop_closed_days(shop, d, d + 5)) = 0, 'one barber off is not a closed shop';

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
  assert (select not is_closure and reason = 'Kursus' from shop_closed_days(shop, d + 7, d + 7)),
    'a day everyone is off reads as closed';

  assert reopen_shop_days(d, 8) = 3, 'reopening counts the closed days it opened';
  assert (select array_agg(day) from shop_closed_days(shop, d, d + 7)) = array[d + 7],
    'only the barbers'' own days off are left';
  assert (select count(*) from bookings where shop_id = shop and is_block and status = 'confirmed'
          and starts_at >= (d::timestamp at time zone 'Asia/Kuala_Lumpur')) = 3,
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

-- Only the customer moves it: not the shop, and never blocked time.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  v_id uuid;
begin
  select id into v_id from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  begin
    perform reschedule_booking(v_id, (d + time '10:00') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'the shop should not move a customer''s booking';
  exception when sqlstate 'P0002' then null;
  end;
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

-- The owner deletes their account: the shop and everything in it goes.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
set role authenticated;
do $$ begin perform delete_my_account(); end $$;
reset role;
do $$ begin
  assert (select count(*) from shops) = 0, 'the shop should be gone';
  assert (select count(*) from barbers) = 0 and (select count(*) from services) = 0
     and (select count(*) from working_hours) = 0 and (select count(*) from bookings) = 0,
    'everything in the shop should be gone';
  assert exists (select 1 from profiles where id = '00000000-0000-0000-0000-0000000000c1'),
    'customers keep their accounts';
end $$;

reset role;
\echo 'All booking tests passed.'
