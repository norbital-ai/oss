import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guestUrlForChromium, isHeadedRun } from '../src/headed-chromium.ts';

describe('guestUrlForChromium', () => {
	it('is headless unless PLAYWRIGHT_HEADED=1', () => {
		const previous = process.env['PLAYWRIGHT_HEADED'];
		delete process.env['PLAYWRIGHT_HEADED'];
		assert.equal(isHeadedRun(), false);
		process.env['PLAYWRIGHT_HEADED'] = '1';
		assert.equal(isHeadedRun(), true);
		if (previous === undefined) delete process.env['PLAYWRIGHT_HEADED'];
		else process.env['PLAYWRIGHT_HEADED'] = previous;
	});

	it('binds loopback guests to 127.0.0.1, not Docker DNS', () => {
		assert.equal(guestUrlForChromium('127.0.0.1', 4317, '/readyz'), 'http://127.0.0.1:4317/readyz');
		assert.equal(guestUrlForChromium('0.0.0.0', 80, 'readyz'), 'http://127.0.0.1:80/readyz');
		assert.equal(guestUrlForChromium('10.0.0.4', 4317, '/readyz'), 'http://10.0.0.4:4317/readyz');
	});
});
