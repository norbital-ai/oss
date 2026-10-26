import type { WorkspaceMember } from './types.js';
import type { ReleaseBuild } from '../releases/model.js';

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
		const lastSeen = member.lastSeen === null ? NaN : Date.parse(member.lastSeen);
		switch (status) {
			case 'recent':
				return member.active && lastSeen > cutoff;
			case 'enabled':
				return member.active;
			case 'disabled':
				return !member.active;
			case 'offline':
				return member.active && lastSeen <= cutoff;
			case 'unknown':
				return !Number.isFinite(lastSeen);
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
