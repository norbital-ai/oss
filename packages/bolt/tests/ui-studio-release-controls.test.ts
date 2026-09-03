import { describe, expect, it } from 'vitest';
import { canRestoreRelease, releaseControls } from '../src/client/ui/studio/studio-state.js';

describe('Studio release controls', () => {
	it('permits Preview and Review from the personal workbench', () => {
		expect(
			releaseControls({
				busy: false,
				hasRelease: true
			})
		).toEqual({ canPreview: true, canRequestReview: true, canRollback: true });
	});

	it('disables every operation while another command is running', () => {
		expect(
			releaseControls({
				busy: true,
				hasRelease: true
			})
		).toMatchObject({ canPreview: false, canRequestReview: false, canRollback: false });
	});

	it('restores only a selected past release', () => {
		const past = {
			releaseId: 'release-old',
			artifactId: undefined,
			current: false,
			commit: 'abc',
			checkpointAt: '2026-09-04T00:00:00.000Z',
			build: undefined,
			deploy: []
		};
		const current = { ...past, releaseId: 'release-live', current: true };
		expect(canRestoreRelease({ busy: false, selected: past })).toBe(true);
		expect(canRestoreRelease({ busy: false, selected: current })).toBe(false);
		expect(canRestoreRelease({ busy: true, selected: past })).toBe(false);
		expect(canRestoreRelease({ busy: false, selected: undefined })).toBe(false);
	});
});
