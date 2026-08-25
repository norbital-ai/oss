import { describe, expect, it } from 'vitest';
import { presentWorkbenchStatus } from '../../src/client/ui/studio/workbench-status-presentation.js';

describe('Workbench status presentation', () => {
	it('uses one compact loading label and exposes a real busy state', () => {
		expect(
			presentWorkbenchStatus({
				hostStatus: 'Loading workspace state…',
				busy: false,
				previewReady: false
			})
		).toMatchObject({ label: 'Loading workspace', loading: true, variant: 'outline' });

		expect(
			presentWorkbenchStatus({ hostStatus: 'Ready', busy: true, previewReady: true })
		).toMatchObject({ label: 'Updating workspace', loading: true, variant: 'outline' });
	});

	it('shows readiness only when the current Preview can be reviewed', () => {
		expect(
			presentWorkbenchStatus({ hostStatus: 'Ready', busy: false, previewReady: false })
		).toBeUndefined();
		expect(
			presentWorkbenchStatus({ hostStatus: 'Ready', busy: false, previewReady: true })
		).toMatchObject({ label: 'Ready for review', loading: false, variant: 'success' });
	});

	it('normalizes host errors and recoverable blockers without losing their detail', () => {
		const unavailable = presentWorkbenchStatus({
			hostStatus: 'Unavailable: connection refused',
			busy: false,
			previewReady: false
		});
		expect(unavailable).toMatchObject({
			label: 'Host unavailable',
			detail: 'Unavailable: connection refused',
			variant: 'destructive'
		});

		expect(
			presentWorkbenchStatus({
				hostStatus: 'Resolve 2 conflicted files, then Rebase again.',
				busy: false,
				previewReady: false
			})
		).toMatchObject({ label: 'Action required', variant: 'warning' });
	});
});
