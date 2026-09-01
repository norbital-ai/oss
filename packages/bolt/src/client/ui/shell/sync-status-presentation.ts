import type { ClientState } from '#lib/client/sync/machine.js';

export type WorkspaceSyncNotice = Readonly<{
	readonly key: 'pending' | 'closed';
	readonly tone: 'warning' | 'destructive';
	readonly icon: string;
	readonly title: string;
	readonly description: string;
}>;

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
	count === 1 ? singular : pluralForm;

export const workspaceSyncNotices = (
	state: Pick<ClientState, 'link' | 'writes'> | undefined
): ReadonlyArray<WorkspaceSyncNotice> => {
	if (state === undefined) return [];
	const notices: WorkspaceSyncNotice[] = [];
	if (state.link === 'closed') {
		notices.push({
			key: 'closed',
			tone: 'destructive',
			icon: 'lucide:cloud-off',
			title: 'Workspace connection closed',
			description: 'This client cannot reconnect to the workspace release it was opened with.'
		});
	}
	if (state.writes.size > 0) {
		const count = state.writes.size;
		notices.push({
			key: 'pending',
			tone: 'warning',
			icon: 'lucide:cloud-upload',
			title: `${count} ${plural(count, 'change')} not yet confirmed by the server`,
			description:
				'Visible in this tab and queued in memory. Keep this tab open until the server confirms it.'
		});
	}
	return notices;
};

type WorkspaceSyncIndicator = Readonly<{
	readonly state: ClientState['link'];
	readonly tone: 'success' | 'neutral' | 'warning';
	readonly icon: string;
	readonly label: string;
}>;

export const workspaceSyncIndicator = (
	state: Pick<ClientState, 'link'> | undefined
): WorkspaceSyncIndicator => {
	switch (state?.link) {
		case 'live':
			return { state: 'live', tone: 'success', icon: 'lucide:cloud', label: 'Connected' };
		case 'closed':
			return {
				state: 'closed',
				tone: 'warning',
				icon: 'lucide:cloud-off',
				label: 'Connection closed'
			};
		default:
			return {
				state: 'reconnecting',
				tone: 'neutral',
				icon: 'lucide:refresh-cw',
				label: 'Reconnecting'
			};
	}
};
