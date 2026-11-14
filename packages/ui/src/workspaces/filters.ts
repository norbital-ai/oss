import type { WorkspaceMember } from './types.js';
import type { ReleaseVersion } from '../releases/model.js';

/**
 * A member's activity, which the users list filters on: `disabled`; else `recent` within five minutes of `now`;
 * `unknown` with no readable activity; else `offline`.
 */
export const memberStatus = (
	member: WorkspaceMember,
	now: string
): 'recent' | 'offline' | 'unknown' | 'disabled' => {
	if (!member.active) return 'disabled';
	const last_seen = member.last_seen === null ? NaN : Date.parse(member.last_seen);
	return !Number.isFinite(last_seen)
		? 'unknown'
		: last_seen > Date.parse(now) - 300_000
			? 'recent'
			: 'offline';
};

/** Releases newest first. */
export const newestReleases = (releases: ReadonlyArray<ReleaseVersion>) =>
	[...releases].sort((a, b) => b.at.localeCompare(a.at));

/**
 * The time a release served, named by its publication instant (`at`): from it until the next publication. `null` is
 * every release (no bound).
 */
export const release_window = (
	releases: ReadonlyArray<ReleaseVersion>,
	at: string | null
): { readonly since?: string; readonly until?: string } => {
	if (at === null) return {};
	const next = releases
		.map((release) => release.at)
		.filter((other) => other > at)
		.sort()[0];
	return next === undefined ? { since: at } : { since: at, until: next };
};
