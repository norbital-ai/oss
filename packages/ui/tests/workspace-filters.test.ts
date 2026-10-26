import { describe, expect, it } from '@effect/vitest';
import { filterBuilds, filterMembers } from '../src/workspaces/filters.js';

const now = '2026-10-26T00:10:00.000Z';
const members = [
	{
		id: 'ada-id',
		name: 'Ada Lovelace',
		email: 'ada@example.com',
		active: true,
		lastSeen: '2026-10-26T00:05:00.001Z'
	},
	{
		id: 'boundary',
		name: 'Boundary',
		email: null,
		active: true,
		lastSeen: '2026-10-26T00:05:00.000Z'
	},
	{
		id: 'quiet',
		name: 'Quiet',
		email: 'quiet@example.com',
		active: true,
		lastSeen: '2026-10-25T00:00:00.000Z'
	},
	{ id: 'unknown', name: 'Unknown', email: null, active: true, lastSeen: null },
	{
		id: 'disabled',
		name: 'Disabled',
		email: 'disabled@example.com',
		active: false,
		lastSeen: '2026-10-26T00:09:00.000Z'
	}
] satisfies Parameters<typeof filterMembers>[0];
const memberIds = (status: string, search = '') =>
	filterMembers(members, search, status, now).map((member) => member.id);

describe('workspace member filters', () => {
	it('uses the five-minute boundary and excludes disabled users from activity filters', () => {
		expect(memberIds('recent')).toEqual(['ada-id']);
		expect(memberIds('offline')).toEqual(['boundary', 'quiet']);
		expect(memberIds('enabled')).toEqual(['ada-id', 'boundary', 'quiet', 'unknown']);
		expect(memberIds('disabled')).toEqual(['disabled']);
		expect(memberIds('unknown')).toEqual(['unknown']);
	});
	it('searches names, email addresses and IDs case-insensitively with trimmed input', () => {
		expect(memberIds('all', '  LOVELACE ')).toEqual(['ada-id']);
		expect(memberIds('all', ' ADA@EXAMPLE.COM ')).toEqual(['ada-id']);
		expect(memberIds('all', ' ADA-ID ')).toEqual(['ada-id']);
		expect(memberIds('disabled', 'lovelace')).toEqual([]);
		expect(memberIds('all', 'null')).toEqual([]);
	});
	it('preserves unknown timestamps and handles empty results without mutating input', () => {
		const invalid = {
			...members[0],
			id: 'invalid',
			name: 'Invalid',
			email: null,
			active: true,
			lastSeen: 'invalid'
		};
		expect(filterMembers([invalid], '', 'unknown', now)).toEqual([invalid]);
		expect(filterMembers([invalid], '', 'offline', now)).toEqual([]);
		expect(filterMembers([], '', 'all', now)).toEqual([]);
		const answer = filterMembers(members, ' ', 'all', now);
		expect(answer).toEqual(members);
		expect(answer).not.toBe(members);
		expect(members.map((member) => member.id)).toEqual([
			'ada-id',
			'boundary',
			'quiet',
			'unknown',
			'disabled'
		]);
	});
});

const builds = [
	{
		commit: 'aaa111',
		at: '2026-10-26T00:10:00Z',
		status: 'failed',
		message: 'Broken migration',
		deployed: false,
		live: false,
		lines: 3,
		diagnostics: 1
	},
	{
		commit: 'bbb222',
		at: '2026-10-26T00:09:00Z',
		status: 'built',
		message: 'Current release',
		deployed: true,
		live: true,
		lines: 1,
		diagnostics: 0
	},
	{
		commit: 'ccc333',
		at: '2026-10-25T00:08:00Z',
		status: 'built',
		message: 'Earlier build',
		deployed: false,
		live: false,
		lines: 1,
		diagnostics: 0
	}
] satisfies Parameters<typeof filterBuilds>[0];
const buildCommits = (status: string, search = '') =>
	filterBuilds(builds, search, status).map((build) => build.commit);

describe('workspace build filters', () => {
	it('keeps live separate from successful builds', () => {
		expect(buildCommits('live')).toEqual(['bbb222']);
		expect(buildCommits('built')).toEqual(['bbb222', 'ccc333']);
		expect(buildCommits('failed')).toEqual(['aaa111']);
	});
	it('searches commit, timestamp and message together with status', () => {
		expect(buildCommits('all', ' BBB222 ')).toEqual(['bbb222']);
		expect(buildCommits('all', '2026-10-25')).toEqual(['ccc333']);
		expect(buildCommits('failed', '  MIGRATION ')).toEqual(['aaa111']);
		expect(buildCommits('built', 'migration')).toEqual([]);
	});
	it('preserves backend order and input for all or empty matches', () => {
		const answer = filterBuilds(builds, ' ', 'all');
		expect(answer).toEqual(builds);
		expect(answer).not.toBe(builds);
		expect(buildCommits('all')).toEqual(['aaa111', 'bbb222', 'ccc333']);
		expect(filterBuilds([], '', 'all')).toEqual([]);
		expect(filterBuilds(builds, 'missing', 'all')).toEqual([]);
	});
});
