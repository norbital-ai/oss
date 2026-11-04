import { describe, expect, it } from 'vitest';
import { noticeAge, sortNotices } from '../src/shell/notices.ts';
import type { NoticeRow } from '../src/protocol/schema.ts';

const notice = (id: string, fields: Partial<NoticeRow> = {}): NoticeRow => ({
	id,
	title: id,
	body: null,
	link: null,
	at: '2026-11-05T00:00:00.000Z',
	read: false,
	...fields
});
const order = { model: 'orders', id: '1' };

describe('the bell’s sorting', () => {
	it('keeps workspace events apart from what is addressed to the reader', () => {
		const { forYou, workspace } = sortNotices([notice('event:merged:u1'), notice('assigned')]);
		expect(forYou.map((group) => group.key)).toEqual(['assigned']);
		expect(workspace.map((group) => group.key)).toEqual(['event:merged:u1']);
	});
	it('reads every notice about one record as one line, newest on top, in place of its newest', () => {
		const { forYou } = sortNotices([
			notice('newer', { link: order }),
			notice('other'),
			notice('older', { link: order, read: true })
		]);
		expect(forYou.map((group) => group.key)).toEqual(['orders/1', 'other']);
		expect(forYou[0]?.rows.map((row) => row.id)).toEqual(['newer', 'older']);
		expect(forYou[0]?.unread).toEqual(['newer']);
	});
	it('never merges notices that name no record', () => {
		expect(sortNotices([notice('a'), notice('b')]).forYou).toHaveLength(2);
	});
});
describe('a notice’s age', () => {
	const now = Date.parse('2026-11-05T12:00:00.000Z');
	it.each([
		['2026-11-05T11:59:30.000Z', 'now'],
		['2026-11-05T11:55:00.000Z', '5m'],
		['2026-11-05T09:00:00.000Z', '3h'],
		['2026-11-03T12:00:00.000Z', '2d'],
		['2026-10-15T12:00:00.000Z', '3w']
	])('%s reads %s', (at, age) => expect(noticeAge(at, now)).toBe(age));
});
