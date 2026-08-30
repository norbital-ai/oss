import type { ClientState } from '#lib/client/sync/machine.js';

export type WorkspaceSyncNotice = Readonly<{
	readonly key: 'pending' | 'reload';
	readonly tone: 'warning' | 'destructive';
	readonly icon: string;
	readonly title: string;
	readonly description: string;
}>;

const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
	count === 1 ? singular : pluralForm;

/** Only user work and the one terminal action interrupt the workspace. */
export const workspaceSyncNotices = (
	state: Pick<ClientState, 'link' | 'writes'> | undefined
): ReadonlyArray<WorkspaceSyncNotice> => {
	if (state === undefined) return [];
	const notices: WorkspaceSyncNotice[] = [];
	if (state.link === 'needsReload') {
		notices.push({
			key: 'reload',
			tone: 'destructive',
			icon: 'lucide:refresh-ccw',
			title: 'Workspace update required',
			description: 'Reload to connect this tab to the active workspace release.'
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

/** Compact chrome for the Machine's only three link states. */
export const workspaceSyncIndicator = (
	state: Pick<ClientState, 'link'> | undefined
): WorkspaceSyncIndicator => {
	switch (state?.link) {
		case 'live':
			return { state: 'live', tone: 'success', icon: 'lucide:cloud', label: 'Connected' };
		case 'needsReload':
			return {
				state: 'needsReload',
				tone: 'warning',
				icon: 'lucide:refresh-ccw',
				label: 'Reload required'
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
