import { describe, expect, it } from '@effect/vitest';
import { memberStatus, newestReleases, release_window } from '../src/workspaces/filters.js';

const now = '2026-10-26T00:10:00.000Z';
const member = (id: string, active: boolean, last_seen: string | null) => ({
	id,
	name: id,
	email: null,
	active,
	last_seen
});

describe('workspace member status', () => {
	it('uses the five-minute boundary; a disabled member is disabled whatever its activity', () => {
		expect(memberStatus(member('ada', true, '2026-10-26T00:05:00.001Z'), now)).toBe('recent');
		expect(memberStatus(member('boundary', true, '2026-10-26T00:05:00.000Z'), now)).toBe('offline');
		expect(memberStatus(member('quiet', true, '2026-10-25T00:00:00.000Z'), now)).toBe('offline');
		expect(memberStatus(member('none', true, null), now)).toBe('unknown');
		expect(memberStatus(member('invalid', true, 'invalid'), now)).toBe('unknown');
		expect(memberStatus(member('off', false, '2026-10-26T00:09:00.000Z'), now)).toBe('disabled');
	});
});

describe('release log windows', () => {
	const release = (commit: string, at: string, current = false) => ({
		commit,
		at,
		message: '',
		current
	});
	const releases = [
		release('aaa', '2026-10-01T00:00:00.000Z'),
		release('ccc', '2026-10-03T00:00:00.000Z', true),
		release('bbb', '2026-10-02T00:00:00.000Z')
	];
	it('a release serves from its publication until the next one; the newest is open-ended', () => {
		expect(newestReleases(releases).map((r) => r.commit)).toEqual(['ccc', 'bbb', 'aaa']);
		expect(release_window(releases, '2026-10-01T00:00:00.000Z')).toEqual({
			since: '2026-10-01T00:00:00.000Z',
			until: '2026-10-02T00:00:00.000Z'
		});
		expect(release_window(releases, '2026-10-03T00:00:00.000Z')).toEqual({
			since: '2026-10-03T00:00:00.000Z'
		});
		expect(release_window(releases, null)).toEqual({});
	});
});
