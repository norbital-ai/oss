import type { WorkspaceMember } from './types.js';
import type { ReleaseBuild, ReleaseVersion } from '../releases/model.js';

export const filterMembers = (
	members: ReadonlyArray<WorkspaceMember>,
	search: string,
	status: string,
	now: string
) => {
	const query = search.trim().toLowerCase();
	const cutoff = Date.parse(now) - 300_000;
	return members.filter((member) => {
		if (!`${member.name} ${member.email ?? ''} ${member.id}`.toLowerCase().includes(query))
			return false;
		const last_seen = member.last_seen === null ? NaN : Date.parse(member.last_seen);
		switch (status) {
			case 'recent':
				return member.active && last_seen > cutoff;
			case 'enabled':
				return member.active;
			case 'disabled':
				return !member.active;
			case 'offline':
				return member.active && last_seen <= cutoff;
			case 'unknown':
				return !Number.isFinite(last_seen);
			default:
				return true;
		}
	});
};

export const filterBuilds = (
	builds: ReadonlyArray<ReleaseBuild>,
	search: string,
	status: string
) => {
	const query = search.trim().toLowerCase();
	return builds.filter(
		(build) =>
			`${build.commit} ${build.at} ${build.message}`.toLowerCase().includes(query) &&
			(status === 'live'
				? build.live
				: status === 'built' || status === 'failed'
					? build.status === status
					: true)
	);
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
