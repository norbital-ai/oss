type WorkbenchStatusPresentation = Readonly<{
	labelKey:
		| 'bolt.studio.status.updating'
		| 'bolt.studio.status.loading'
		| 'bolt.studio.status.readyForReview'
		| 'bolt.studio.status.hostUnavailable'
		| 'bolt.studio.status.actionFailed'
		| 'bolt.studio.status.actionRequired'
		| 'bolt.studio.status.updated';
	detailKey?: 'bolt.studio.status.updatingDetail' | 'bolt.studio.status.readyForReviewDetail';
	detail?: string;
	icon: string;
	variant: 'outline' | 'success' | 'warning' | 'destructive';
	loading: boolean;
	testId: 'studio-host-status' | 'studio-preview-status';
}>;

const status = (
	labelKey: WorkbenchStatusPresentation['labelKey'],
	extra: Partial<Omit<WorkbenchStatusPresentation, 'labelKey'>> = {}
): WorkbenchStatusPresentation => ({
	labelKey,
	icon: 'lucide:circle-alert',
	variant: 'destructive',
	loading: false,
	testId: 'studio-host-status',
	...extra
});

export const presentWorkbenchStatus = (input: {
	readonly hostStatus: string;
	readonly busy: boolean;
	readonly previewReady: boolean;
}): WorkbenchStatusPresentation | undefined => {
	const { hostStatus, busy, previewReady } = input;
	if (busy)
		return status('bolt.studio.status.updating', {
			detailKey: 'bolt.studio.status.updatingDetail',
			icon: 'lucide:loader-2',
			variant: 'outline',
			loading: true
		});
	if (hostStatus.startsWith('Loading'))
		return status('bolt.studio.status.loading', {
			detail: hostStatus,
			icon: 'lucide:loader-2',
			variant: 'outline',
			loading: true
		});
	if (hostStatus === 'Ready')
		return previewReady
			? status('bolt.studio.status.readyForReview', {
					detailKey: 'bolt.studio.status.readyForReviewDetail',
					icon: 'lucide:circle-check',
					variant: 'success',
					testId: 'studio-preview-status'
				})
			: undefined;
	if (
		hostStatus.startsWith('Unavailable:') ||
		hostStatus.includes('trusted Colony routing headers are required')
	)
		return status('bolt.studio.status.hostUnavailable', { detail: hostStatus });
	if (hostStatus.startsWith('Failed:'))
		return status('bolt.studio.status.actionFailed', { detail: hostStatus });
	if (hostStatus.startsWith('Resolve ') || hostStatus.startsWith('Migration ready'))
		return status('bolt.studio.status.actionRequired', {
			detail: hostStatus,
			icon: 'lucide:triangle-alert',
			variant: 'warning'
		});
	return status('bolt.studio.status.updated', {
		detail: hostStatus,
		icon: 'lucide:circle-check',
		variant: 'success'
	});
};
