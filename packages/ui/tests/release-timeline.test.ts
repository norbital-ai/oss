import { describe, expect, it } from '@effect/vitest';
import {
	rollbackReason,
	timelineEntries,
	type ReleaseBuild,
	type ReleaseChange,
	type ReleaseVersion
} from '../src/releases/model.js';

const build: ReleaseBuild = {
	commit: 'build-a',
	at: '2026-10-26T10:00:00.000Z',
	status: 'built',
	message: 'Update operations',
	deployed: true,
	live: false,
	lines: 8,
	diagnostics: 0
};
const published: ReleaseVersion = {
	commit: build.commit,
	at: '2026-10-26T10:01:00.000Z',
	message: build.message,
	current: false,
	checkpoint: '2026-10-26T10:01:00.000Z'
};
const change: ReleaseChange = {
	id: 'change-a',
	title: 'Operations update',
	state: 'open',
	head: 'build-b',
	updatedAt: '2026-10-26T11:00:00.000Z',
	preview: { commit: build.commit, artifact: 'artifact-a', url: '/preview', stale: true }
};

describe('build and release timeline', () => {
	it('consolidates a commit while preserving every publication and preview reference', () => {
		const republished = { ...published, current: true, at: '2026-10-26T12:00:00.000Z' };
		const entries = timelineEntries([build], [published, republished], [change]);
		expect(entries.map((entry) => entry.commit)).toEqual(['build-a', 'build-b']);
		expect(entries[0]).toMatchObject({
			build,
			publications: [republished, published],
			previews: [change],
			changes: []
		});
		expect(entries[1]).toMatchObject({ build: null, changes: [change], publications: [] });
	});
	it('keeps failed or unpublished builds and sorts by their latest known event without mutating inputs', () => {
		const failed = {
			...build,
			commit: 'failed',
			status: 'failed' as const,
			at: '2026-10-26T13:00:00.000Z'
		};
		const builds = [build, failed];
		expect(timelineEntries(builds, [published]).map((entry) => entry.commit)).toEqual([
			'failed',
			'build-a'
		]);
		expect(builds).toEqual([build, failed]);
		expect(timelineEntries([], [])).toEqual([]);
	});
	it('never offers a current, reset or uncheckpointed version as a rollback destination', () => {
		expect(rollbackReason(published)).toBeNull();
		expect(rollbackReason({ ...published, current: true })).toBe('This commit is already live.');
		expect(rollbackReason({ ...published, replaced: true })).toContain('last reset');
		expect(rollbackReason({ ...published, checkpoint: null })).toContain('no checkpoint');
		const legacy: ReleaseVersion = {
			commit: build.commit,
			at: published.at,
			message: build.message,
			current: false
		};
		expect(rollbackReason(legacy)).toContain('no checkpoint');
	});
});
