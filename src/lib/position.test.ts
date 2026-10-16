/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approximateOnly, exactEnough, framedWithoutLocation, SHOP_FIX_M } from './position.ts';

test('approximateOnly spots an approximate location on Android and iPhone', () => {
  assert.equal(approximateOnly({ android: { accuracy: 'coarse' } }), true);
  assert.equal(approximateOnly({ ios: { accuracy: 'reduced' } }), true);
  assert.equal(approximateOnly({ android: { accuracy: 'fine' } }), false);
  assert.equal(approximateOnly({ ios: { accuracy: 'full' } }), false);
  // Browsers don't say; how close the fix is then decides.
  assert.equal(approximateOnly({}), false);
  assert.equal(approximateOnly(null), false);
});

test('exactEnough takes a fix that finds the door, not the street', () => {
  assert.equal(SHOP_FIX_M, 50);
  assert.equal(exactEnough(0), true);
  assert.equal(exactEnough(12), true);
  assert.equal(exactEnough(50), true);
  assert.equal(exactEnough(65), false); // an iPhone indoors on Wi-Fi alone
  assert.equal(exactEnough(1500), false); // a laptop placed by its network
  assert.equal(exactEnough(null), false);
  assert.equal(exactEnough(undefined), false);
  assert.equal(exactEnough(Number.NaN), false);
  assert.equal(exactEnough(-1), false);
});

test('framedWithoutLocation is true only when the page is told it may not have location', () => {
  const policy = (allowed: boolean) => ({ allowsFeature: (f: string) => (f === 'geolocation' ? allowed : true) });
  assert.equal(framedWithoutLocation({ featurePolicy: policy(false) }), true);
  assert.equal(framedWithoutLocation({ permissionsPolicy: policy(false) }), true);
  assert.equal(framedWithoutLocation({ permissionsPolicy: policy(true), featurePolicy: policy(false) }), false);
  assert.equal(framedWithoutLocation({ featurePolicy: policy(true) }), false);
  // Browsers that can't tell, the apps (no document) and a policy that throws all leave it to the browser.
  assert.equal(framedWithoutLocation({}), false);
  assert.equal(framedWithoutLocation(undefined), false);
  assert.equal(
    framedWithoutLocation({
      featurePolicy: {
        allowsFeature: () => {
          throw new Error('unknown feature');
        },
      },
    }),
    false,
  );
});
