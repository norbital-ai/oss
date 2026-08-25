type WorkbenchStatusPresentation = Readonly<{
	label: string;
	detail: string;
	icon: string;
	variant: 'outline' | 'success' | 'warning' | 'destructive';
	loading: boolean;
	testId: 'studio-host-status' | 'studio-preview-status';
}>;

/**
 * Reduce host prose to the compact status vocabulary used by the Workbench toolbar.
 *
 * Host messages remain available as detail text, while the visible label is stable across long
 * errors, intermediate operation messages, and narrow viewports. Busy is checked first so a
 * workspace operation never leaves the previous success state visible while it runs.
 */
export const presentWorkbenchStatus = (input: {
	readonly hostStatus: string;
	readonly busy: boolean;
	readonly previewReady: boolean;
}): WorkbenchStatusPresentation | undefined => {
	const { hostStatus, busy, previewReady } = input;
	if (busy) {
		return {
			label: 'Updating workspace',
			detail: 'A workspace operation is in progress.',
			icon: 'lucide:loader-2',
			variant: 'outline',
			loading: true,
			testId: 'studio-host-status'
		};
	}
	if (hostStatus.startsWith('Loading')) {
		return {
			label: 'Loading workspace',
			detail: hostStatus,
			icon: 'lucide:loader-2',
			variant: 'outline',
			loading: true,
			testId: 'studio-host-status'
		};
	}
	if (hostStatus === 'Ready') {
		return previewReady
			? {
					label: 'Ready for review',
					detail: 'The current workbench matches Preview and can be sent to Review.',
					icon: 'lucide:circle-check',
					variant: 'success',
					loading: false,
					testId: 'studio-preview-status'
				}
			: undefined;
	}
	if (
		hostStatus.startsWith('Unavailable:') ||
		hostStatus.includes('trusted Colony routing headers are required')
	) {
		return {
			label: 'Host unavailable',
			detail: hostStatus,
			icon: 'lucide:circle-alert',
			variant: 'destructive',
			loading: false,
			testId: 'studio-host-status'
		};
	}
	if (hostStatus.startsWith('Failed:')) {
		return {
			label: 'Action failed',
			detail: hostStatus,
			icon: 'lucide:circle-alert',
			variant: 'destructive',
			loading: false,
			testId: 'studio-host-status'
		};
	}
	if (hostStatus.startsWith('Resolve ') || hostStatus.startsWith('Migration ready')) {
		return {
			label: 'Action required',
			detail: hostStatus,
			icon: 'lucide:triangle-alert',
			variant: 'warning',
			loading: false,
			testId: 'studio-host-status'
		};
	}
	return {
		label: 'Workspace updated',
		detail: hostStatus,
		icon: 'lucide:circle-check',
		variant: 'success',
		loading: false,
		testId: 'studio-host-status'
	};
};
