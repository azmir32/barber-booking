/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { distanceText, kmBetween, roughly, shopPoint } from './distance.ts';
import { directionsUrl } from './maps.ts';

const near = (actual: number, expected: number, within: number) =>
  assert.ok(Math.abs(actual - expected) < within, `${actual} is not within ${within} of ${expected}`);

test('kmBetween measures over the earth as km_between does', () => {
  near(kmBetween({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }), 111.195, 0.001);
  assert.equal(kmBetween({ latitude: 2.9833, longitude: 101.7667 }, { latitude: 2.9833, longitude: 101.7667 }), 0);
  // Opposite sides of the earth, where a rounding error must not break it.
  near(kmBetween({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }), 20015.114, 0.01);
  // Sungai Chua to Ali's door and to the middle of Kajang town, as booking_test.sql has them.
  const sungaiChua = { latitude: 2.9833, longitude: 101.7667 };
  near(kmBetween(sungaiChua, { latitude: 2.9846, longitude: 101.7712 }), 0.52, 0.005);
  near(kmBetween(sungaiChua, { latitude: 2.9925, longitude: 101.7884 }), 2.618, 0.005);
  assert.equal(
    kmBetween(sungaiChua, { latitude: 2.9925, longitude: 101.7884 }),
    kmBetween({ latitude: 2.9925, longitude: 101.7884 }, sungaiChua),
  );
});

test('distances read as people say them', () => {
  assert.equal(distanceText(0), '100 m');
  assert.equal(distanceText(0.04), '100 m');
  assert.equal(distanceText(0.52), '500 m');
  assert.equal(distanceText(0.8), '800 m');
  assert.equal(distanceText(0.849), '800 m');
  // Just under a kilometre rounds up to one, not "1000 m".
  assert.equal(distanceText(0.96), '1 km');
  assert.equal(distanceText(1.2), '1.2 km');
  assert.equal(distanceText(1.25), '1.3 km');
  assert.equal(distanceText(2.618), '2.6 km');
  assert.equal(distanceText(3.0), '3 km');
  assert.equal(distanceText(9.94), '9.9 km');
  // Ten and over in whole kilometres, including 9.96 rounding up.
  assert.equal(distanceText(9.96), '10 km');
  assert.equal(distanceText(12.4), '12 km');
  assert.equal(distanceText(151.6), '152 km');
});

test('the customer’s position is kept to about 100 m', () => {
  assert.deepEqual(roughly({ latitude: 2.983349, longitude: 101.766651 }), { latitude: 2.983, longitude: 101.767 });
  assert.deepEqual(roughly({ latitude: -33.86882, longitude: 151.20929 }), { latitude: -33.869, longitude: 151.209 });
});

test('a shop has a point only with both halves of one', () => {
  assert.deepEqual(shopPoint({ latitude: 2.9846, longitude: 101.7712 }), { latitude: 2.9846, longitude: 101.7712 });
  assert.equal(shopPoint({ latitude: null, longitude: null }), null);
  assert.equal(shopPoint({ latitude: 2.9846, longitude: null }), null);
  assert.equal(shopPoint({}), null);
  // On the equator or the prime meridian is still a place.
  assert.deepEqual(shopPoint({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
});

test('Directions go to the shop’s own point when it has one, else its address', () => {
  const shop = { name: 'Ali Barber', address: 'No. 12, Jalan Sungai Chua 3/1, 43000 Kajang', area: 'Sungai Chua' };
  assert.equal(
    directionsUrl({ ...shop, latitude: 2.9846, longitude: 101.7712 }),
    'https://www.google.com/maps/search/?api=1&query=2.9846%2C101.7712',
  );
  assert.equal(
    directionsUrl({ ...shop, latitude: null, longitude: null }),
    'https://www.google.com/maps/search/?api=1&query=Ali%20Barber%2C%20No.%2012%2C%20Jalan%20Sungai%20Chua%203%2F1%2C%2043000%20Kajang',
  );
  assert.equal(
    directionsUrl({ ...shop, address: null }),
    'https://www.google.com/maps/search/?api=1&query=Ali%20Barber%2C%20Sungai%20Chua',
  );
});
