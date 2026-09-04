import { describe, expect, it } from 'vitest';
import {
	deleteHistoryIdentity,
	membershipIdentitySnapshot
} from '../src/runtime/collections/write/identity-snapshot.js';

describe('identity-only delete snapshots', () => {
	it('keeps sorted ids and drops every other column', () => {
		expect(
			membershipIdentitySnapshot([
				{ id: 'b-2', body: 'payload-body-'.repeat(200) },
				{ id: 'a-1', fat: { nested: true } }
			])
		).toBe(JSON.stringify(['a-1', 'b-2']));
	});

	it('history of a delete is the id alone', () => {
		expect(deleteHistoryIdentity({ id: 'run-1', payslips: [{ gross: 99_999.99 }] })).toEqual({
			id: 'run-1'
		});
		expect(deleteHistoryIdentity(undefined)).toEqual({});
	});
});
