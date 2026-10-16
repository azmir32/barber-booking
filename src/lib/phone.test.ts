/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toWhatsAppNumber, whatsappUrl } from './phone.ts';

test('toWhatsAppNumber handles local and international formats', () => {
  assert.equal(toWhatsAppNumber('012-345 6789'), '60123456789');
  assert.equal(toWhatsAppNumber('+60 12-345 6789'), '60123456789');
});

test('whatsappUrl encodes the message', () => {
  assert.equal(whatsappUrl('0123456789', 'Hi there'), 'https://wa.me/60123456789?text=Hi%20there');
});
