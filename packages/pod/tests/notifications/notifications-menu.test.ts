import { describe, expect, it } from 'vitest';
import { toNotificationRow, unreadBadge } from '$lib/runtime/notifications.js';

describe('notification bell', () => {
	it('reads a replica record without asserting its shape', () => {
		expect(
			toNotificationRow({
				norbital_id: 'n1',
				subject: 'RFI raised',
				message: 'Waiting on your answer.',
				cta_label: 'Open RFI',
				cta_url: '/app/site',
				notification_category: 'rfi',
				read_at: null,
				norbital_created_at: '2026-07-31T00:00:00.000Z'
			})
		).toEqual([
			{
				norbital_id: 'n1',
				subject: 'RFI raised',
				message: 'Waiting on your answer.',
				cta_label: 'Open RFI',
				cta_url: '/app/site',
				notification_category: 'rfi',
				read_at: null,
				norbital_created_at: '2026-07-31T00:00:00.000Z'
			}
		]);
	});

	it('drops a record it cannot render rather than rendering blanks', () => {
		// The replica's columns are introspected at runtime, so a row without the two fields this
		// surface is entirely made of is not a notification with holes in it.
		expect(toNotificationRow({ norbital_id: 'n1' })).toEqual([]);
		expect(toNotificationRow({ subject: 'Orphan' })).toEqual([]);
	});

	it('keeps the optional half optional', () => {
		const [row] = toNotificationRow({ norbital_id: 'n1', subject: 'Bare' });
		expect(row).toMatchObject({
			message: '',
			cta_label: null,
			cta_url: null,
			notification_category: null,
			read_at: null,
			norbital_created_at: ''
		});
	});

	it('shows nothing when nothing is unread, and a lower bound past nine', () => {
		expect(unreadBadge(0)).toBe('');
		expect(unreadBadge(1)).toBe('1');
		expect(unreadBadge(9)).toBe('9');
		// The list is one page, so an exact count past it would be a number this surface cannot see.
		expect(unreadBadge(10)).toBe('9+');
		expect(unreadBadge(4000)).toBe('9+');
	});
});
