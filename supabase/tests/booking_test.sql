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
  -- One barber's day off doesn't close the shop, and the closure replaces it.
  off := add_shop_booking('00000000-0000-0000-0000-0000000000a2', d + 1, '00:00', 1440,
    p_note => 'Day off', p_is_block => true);
  assert (select count(*) from shop_closed_days(shop, d, d + 5)) = 0, 'one barber off is not a closed shop';

  assert close_shop_days(d, 3, '  Hari Raya  ') = 3, 'closing returns the number of days';
  assert (select array_agg(day order by day) from shop_closed_days(shop, d - 1, d + 5)) = array[d, d + 1, d + 2],
    'the three days should read as closed';
  assert (select bool_and(reason = 'Hari Raya') from shop_closed_days(shop, d, d + 2)), 'the owner sees the reason';
  assert not exists (select 1 from available_slots(svc, d + 2)), 'no slots on a closed day';
  assert exists (select 1 from available_slots(svc, d + 3)), 'the day after reopens';
  assert (select status from bookings where id = off.id) = 'cancelled', 'the barber''s own day off gives way';

  -- Closing the same days again is harmless.
  perform close_shop_days(d, 3, 'Hari Raya');
  assert (select count(*) from bookings where shop_id = shop and is_block and status = 'confirmed'
          and service_name = 'Hari Raya') = 6, 'two barbers, three days, no doubles';

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
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 40;
begin
  begin
    perform close_shop_days(d + 4, 2, 'Kenduri');
    raise exception 'closing over a customer booking should be refused';
  exception when sqlstate 'P0001' then null;
  end;
  assert not exists (select 1 from bookings where service_name = 'Kenduri'), 'a refused closure leaves nothing behind';

  assert reopen_shop_days(d, 3) = 6, 'reopening removes every barber''s block';
  assert (select count(*) from shop_closed_days('00000000-0000-0000-0000-00000000005a', d, d + 5)) = 0,
    'nothing reads as closed after reopening';
  assert exists (select 1 from available_slots('00000000-0000-0000-0000-0000000000e1', d + 1)),
    'the slots come back';
end $$;

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

-- The shop owner moves it back to Ali, but can't move blocked time.
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$
declare
  d date := (now() at time zone 'Asia/Kuala_Lumpur')::date + 5;
  v_id uuid;
  moved bookings;
begin
  select id into v_id from bookings where customer_id = '00000000-0000-0000-0000-0000000000c1'
    and status = 'confirmed' and starts_at > now();
  moved := reschedule_booking(v_id, (d + time '10:00') at time zone 'Asia/Kuala_Lumpur', '00000000-0000-0000-0000-0000000000a1');
  assert moved.barber_id = '00000000-0000-0000-0000-0000000000a1'
     and moved.starts_at = (d + time '10:00') at time zone 'Asia/Kuala_Lumpur', 'the owner should move a booking';
  begin
    perform reschedule_booking((select id from bookings where is_block and status = 'confirmed' and starts_at > now() limit 1),
                               (d + time '10:30') at time zone 'Asia/Kuala_Lumpur');
    raise exception 'blocked time should not move';
  exception when sqlstate 'P0002' then null;
  end;
end $$;

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
