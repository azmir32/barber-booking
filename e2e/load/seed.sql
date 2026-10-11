-- Malaysia-sized data for the load test: about 1,000 live shops with three
-- chairs each, 100,000 customers, and every chair booked through 90 days of
-- history and the next 30 days. Ids are derived from names (md5), so the
-- load script can find shops, barbers and customers without asking.
--
-- psql -v shops=1000 -v customers=100000 -f e2e/load/seed.sql

\if :{?shops} \else \set shops 1000 \endif
\if :{?customers} \else \set customers 100000 \endif

\echo › users and profiles
insert into auth.users (id, email, raw_user_meta_data)
select md5('owner' || i)::uuid, 'owner' || i || '@load.my',
       jsonb_build_object('role', 'barber', 'full_name', 'Owner ' || i, 'phone', '012-' || lpad(i::text, 7, '0'))
from generate_series(1, :shops) i;

insert into auth.users (id, email, raw_user_meta_data)
select md5('customer' || i)::uuid, 'customer' || i || '@load.my',
       jsonb_build_object('role', 'customer', 'full_name', 'Customer ' || i, 'phone', '011-' || lpad(i::text, 8, '0'))
from generate_series(1, :customers) i;

\echo › shops, chairs, services and hours
-- Each shop sits within about 3 km of its town's centre; one in ten hasn't
-- set its location, as some won't.
insert into public.shops (id, owner_id, name, slug, about, address, area, latitude, longitude, phone,
                          is_published, subscription_status)
select md5('shop' || i)::uuid, md5('owner' || i)::uuid,
       'Kedai Gunting ' || i, 'kedai-gunting-' || i,
       'Fades, beard trims and kids cuts. Walk-ins welcome.',
       i || ', Jalan Utama, ' || t.area,
       t.area,
       case when i % 10 <> 7 then t.lat + ((i * 7919) % 600 - 300) / 10000.0 end,
       case when i % 10 <> 7 then t.lng + ((i * 6271) % 600 - 300) / 10000.0 end,
       '012-' || lpad(i::text, 7, '0'), true, 'active'
from generate_series(1, :shops) i
join (values
  (0, 'Kajang', 2.9931, 101.7889), (1, 'Sungai Chua', 2.9846, 101.7712), (2, 'Bangi', 2.9637, 101.7681),
  (3, 'Semenyih', 2.9500, 101.8430), (4, 'Cheras', 3.0790, 101.7380), (5, 'Kuala Lumpur', 3.1390, 101.6869),
  (6, 'Petaling Jaya', 3.1073, 101.6067), (7, 'Shah Alam', 3.0733, 101.5185), (8, 'Subang Jaya', 3.0565, 101.5851),
  (9, 'Puchong', 3.0250, 101.6170), (10, 'Klang', 3.0449, 101.4456), (11, 'Seremban', 2.7259, 101.9378),
  (12, 'Ipoh', 4.5975, 101.0901), (13, 'Johor Bahru', 1.4927, 103.7414), (14, 'George Town', 5.4141, 100.3288),
  (15, 'Kota Bharu', 6.1254, 102.2381), (16, 'Kuantan', 3.8077, 103.3260), (17, 'Melaka', 2.1896, 102.2501),
  (18, 'Alor Setar', 6.1248, 100.3678), (19, 'Kuching', 1.5535, 110.3593)
) t(n, area, lat, lng) on t.n = i % 20;

insert into public.barbers (id, shop_id, name, sort_order)
select md5('barber' || i || '-' || j)::uuid, md5('shop' || i)::uuid, 'Barber ' || j, j
from generate_series(1, :shops) i, generate_series(1, 3) j;

insert into public.services (id, shop_id, name, duration_min, price, sort_order)
select md5('service' || i || '-' || s.n)::uuid, md5('shop' || i)::uuid, s.name, s.minutes, s.price, s.n
from generate_series(1, :shops) i,
     (values (1, 'Haircut', 30, 20), (2, 'Skin fade', 45, 25), (3, 'Haircut + beard', 45, 30),
             (4, 'Beard trim', 15, 12), (5, 'Kids cut', 30, 15)) s(n, name, minutes, price);

insert into public.working_hours (barber_id, weekday, opens_at, closes_at)
select md5('barber' || i || '-' || j)::uuid, d, '10:00', '20:00'
from generate_series(1, :shops) i, generate_series(1, 3) j, generate_series(1, 6) d;

\echo › bookings (a few minutes)
-- Ten 30-minute cuts a day per chair, 45 minutes apart, Monday to Saturday.
-- History is mostly done; the coming month is about 60% full. Customers
-- booked each one online at least three days ahead, the coming ones at some
-- point in the last fortnight, so every shop's Bookings tab has news.
insert into public.bookings (shop_id, barber_id, service_id, customer_id, service_name, price,
                             starts_at, ends_at, status, created_at, customer_changed_at, customer_change)
select md5('shop' || i)::uuid, md5('barber' || i || '-' || j)::uuid, md5('service' || i || '-1')::uuid,
       md5('customer' || (1 + floor(random() * :customers))::int)::uuid,
       'Haircut', 20, t, t + interval '30 minutes',
       (case when t > now() then (case when random() < 0.95 then 'confirmed' else 'cancelled' end)
             else (array['completed', 'completed', 'completed', 'completed', 'completed', 'completed',
                         'completed', 'completed', 'no_show', 'cancelled'])[1 + floor(random() * 10)::int] end
       )::public.booking_status,
       t - interval '3 days',
       least(t - interval '3 days', now() - random() * interval '14 days'),
       'booked'
from generate_series(1, :shops) i,
     generate_series(1, 3) j,
     generate_series(-90, 30) d,
     generate_series(0, 9) k,
     lateral (select ((current_date + d) + time '10:00' + k * interval '45 minutes')
                     at time zone 'Asia/Kuala_Lumpur' as t) slot
where extract(dow from current_date + d) <> 0
  and (d <= 0 or random() < 0.6);

\echo › reviews
-- About one in seven finished cuts is rated a few hours later, mostly four
-- or five stars, half with a comment. The counting trigger is off while
-- they go in, and each shop's count and total are added up once at the end.
alter table public.reviews disable trigger reviews_count;
insert into public.reviews (booking_id, shop_id, barber_id, customer_id, rating, comment, first_name,
                            created_at, updated_at)
select b.id, b.shop_id, b.barber_id, b.customer_id,
       (array[5, 5, 5, 5, 5, 4, 4, 4, 3, 2])[1 + floor(random() * 10)::int],
       case when random() < 0.5 then 'Kemas dan cepat. Will come again.' end,
       'Customer', b.ends_at + interval '3 hours', b.ends_at + interval '3 hours'
from public.bookings b
where b.status = 'completed' and b.customer_id is not null and random() < 0.15;
alter table public.reviews enable trigger reviews_count;
update public.shops s set rating_count = x.n, rating_sum = x.total
from (select shop_id, count(*)::int as n, sum(rating)::int as total from public.reviews group by shop_id) x
where x.shop_id = s.id;

analyze;
\echo › done
