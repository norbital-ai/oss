import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { popoverAlignment } from '../src/kinds/popover-alignment.svelte.js';

it('calendar panels prefer the full field edge that fits the viewport', () => {
	assert.equal(popoverAlignment({ left: 80, right: 280 }, 294, 900), 'start');
	assert.equal(popoverAlignment({ left: 640, right: 870 }, 294, 900), 'end');
	assert.equal(popoverAlignment({ left: 640, right: 870 }, 546, 900), 'end');
	assert.equal(popoverAlignment({ left: 80, right: 780 }, 294, 900), 'start');
});

it('oversized or clipped calendars retain native collision clamping', () => {
	assert.equal(popoverAlignment({ left: 80, right: 280 }, 546, 390), 'start');
	assert.equal(popoverAlignment({ left: -20, right: 180 }, 294, 390), 'start');
	assert.equal(popoverAlignment({ left: 190, right: 390 }, 294, 390, 0), 'end');
});
