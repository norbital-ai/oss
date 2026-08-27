import type { WorkspaceSyncStatus } from '#lib/client/runtime.js';

export type WorkspaceSyncNotice = Readonly<{
	readonly key: 'pending' | 'issues';
	readonly tone: 'neutral' | 'warning' | 'destructive';
	readonly icon: string;
	readonly title: string;
	readonly description: string;
}>;

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
	count === 1 ? singular : pluralForm;

/**
 * What the workspace interrupts a reader to say. Connectivity is never one of these.
 *
 * The engine's own state — connected, syncing, disconnected — belongs in the sidebar, where it is
 * visible without demanding anything. It used to be a stack of floating cards announcing
 * "unverified", "connecting", "disconnected", "out of date" and "up to date", none of which a
 * reader can act on and none of which they can dismiss; on a local workspace they were permanent.
 *
 * Two things are worth a toast, because both are the reader's own work rather than the engine's
 * plumbing: a change that is saved on this device but has not reached the server, and a change the
 * server refused. Everything else is chrome.
 */
export const workspaceSyncNotices = (
	status: WorkspaceSyncStatus | undefined
): ReadonlyArray<WorkspaceSyncNotice> => {
	if (status === undefined) return [];
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
			title: `${status.issues.length} ${plural(status.issues.length, 'change')} need attention`,
			description: `${parts.join(' and ')}. Review the details; the platform has not silently discarded this work.`
		});
	}

	if (status.pendingMutations > 0) {
		const count = status.pendingMutations;
		notices.push({
			key: 'pending',
			tone: 'warning',
			icon: 'lucide:cloud-upload',
			title: `${count} ${plural(count, 'change')} not yet saved to the server`,
			description:
				'Durable on this device and visible here. It will be sent when the connection returns.'
		});
	}

	return notices;
};

/** How the sidebar renders the engine's own state, where it costs a reader nothing to ignore. */
export type WorkspaceSyncIndicator = Readonly<{
	readonly state: WorkspaceSyncStatus['connectivity'];
	readonly tone: 'success' | 'neutral' | 'warning';
	readonly icon: string;
	readonly label: string;
}>;

export const workspaceSyncIndicator = (
	status: WorkspaceSyncStatus | undefined
): WorkspaceSyncIndicator => {
	switch (status?.connectivity) {
		case 'connected':
			return { state: 'connected', tone: 'success', icon: 'lucide:cloud', label: 'Connected' };
		case 'syncing':
			return { state: 'syncing', tone: 'neutral', icon: 'lucide:refresh-cw', label: 'Syncing' };
		default:
			return {
				state: 'disconnected',
				tone: 'warning',
				icon: 'lucide:cloud-off',
				label: 'Disconnected'
			};
	}
};
