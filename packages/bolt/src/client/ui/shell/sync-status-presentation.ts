import type { WorkspaceSyncStatus } from '#lib/client/runtime.js';

export type WorkspaceSyncNotice = Readonly<{
	readonly key:
		| 'unavailable'
		| 'unverified'
		| 'connecting'
		| 'offline'
		| 'disconnected'
		| 'stale'
		| 'pending'
		| 'settled'
		| 'issues';
	readonly tone: 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
	readonly icon: string;
	readonly title: string;
	readonly description: string;
}>;

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
	count === 1 ? singular : pluralForm;

/**
 * Turns the engine's factual counters into platform-owned copy.
 *
 * An absent signal is not an all-clear. Older or incomplete runtimes cannot prove freshness or
 * settlement, so the shell says exactly that instead of falling back to “Up to date”. Likewise,
 * offline and server-proof results never acquire exactness from presentation wording.
 */
export const workspaceSyncNotices = (
	status: WorkspaceSyncStatus | undefined
): ReadonlyArray<WorkspaceSyncNotice> => {
	if (status === undefined) {
		return [
			{
				key: 'unavailable',
				tone: 'warning',
				icon: 'lucide:cloud-alert',
				title: 'Sync status unavailable',
				description: 'Data freshness and change settlement cannot be verified in this workspace.'
			}
		];
	}

	const notices: Array<WorkspaceSyncNotice> = [];
	if (status.issues.length > 0) {
		const rejected = status.issues.filter(({ kind }) => kind === 'rejected').length;
		const quarantined = status.issues.length - rejected;
		const parts = [
			rejected > 0 ? `${rejected} rejected` : undefined,
			quarantined > 0 ? `${quarantined} quarantined` : undefined
		].filter((part): part is string => part !== undefined);
		notices.push({
			key: 'issues',
			tone: 'destructive',
			icon: 'lucide:triangle-alert',
			title: `${status.issues.length} sync ${plural(status.issues.length, 'issue')} need attention`,
			description: `${parts.join(' and ')}. Review the details; the platform has not silently discarded this work.`
		});
	}

	if (status.connectivity === 'offline') {
		notices.push({
			key: 'offline',
			tone: 'warning',
			icon: 'lucide:wifi-off',
			title: 'Offline — downloaded data only',
			description:
				'Search and query results may be incomplete. Locally saved changes will be submitted when a connection is available.'
		});
	} else if (status.connectivity === 'disconnected') {
		notices.push({
			key: 'disconnected',
			tone: 'warning',
			icon: 'lucide:cloud-off',
			title: 'Sync disconnected — downloaded data only',
			description:
				'The authoritative change stream is unavailable. Results may be incomplete while it reconnects.'
		});
	} else if (status.connectivity === 'connecting') {
		notices.push({
			key: 'connecting',
			tone: 'info',
			icon: 'lucide:refresh-cw',
			title: 'Connecting to sync',
			description:
				'Downloaded data remains available, but freshness and settlement are unverified until the stream is live.'
		});
	} else if (status.connectivity === 'unverified') {
		notices.push({
			key: 'unverified',
			tone: 'warning',
			icon: 'lucide:cloud-alert',
			title: 'Sync connection unverified',
			description:
				'A network interface is not proof of a live sync stream. Results may be limited to downloaded data.'
		});
	} else if (status.offlineRetainedOnly) {
		// An online stream paired with retained-only reads is internally inconsistent. Keep the UI on
		// the safe side until the engine publishes a coherent snapshot.
		notices.push({
			key: 'unverified',
			tone: 'warning',
			icon: 'lucide:cloud-alert',
			title: 'Data freshness unverified',
			description: 'Results may be limited to downloaded data until sync restores its proof.'
		});
	}

	if (status.staleServerProofWindows > 0) {
		const count = status.staleServerProofWindows;
		notices.push({
			key: 'stale',
			tone: 'info',
			icon: 'lucide:history',
			title: `${count} server-verified ${plural(count, 'result')} may be out of date`,
			description:
				'Totals, grouped views, and server-only queries show their last verified value until refreshed.'
		});
	}

	if (status.pendingMutations > 0) {
		const count = status.pendingMutations;
		notices.push({
			key: 'pending',
			tone: 'neutral',
			icon: 'lucide:cloud-upload',
			title: `${count} ${plural(count, 'change')} saved on this device`,
			description: 'Locally durable and visible here; still awaiting server confirmation.'
		});
	}

	if (
		status.connectivity === 'online' &&
		!status.offlineRetainedOnly &&
		status.staleServerProofWindows === 0 &&
		status.pendingMutations === 0 &&
		status.settledMutations > 0 &&
		status.issues.length === 0
	) {
		const count = status.settledMutations;
		notices.push({
			key: 'settled',
			tone: 'success',
			icon: 'lucide:cloud-check',
			title: 'All locally saved changes confirmed',
			description: `${count} ${plural(count, 'change')} confirmed by the server in this session.`
		});
	}

	return notices;
};
