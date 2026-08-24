import { describe, expect, it } from 'vitest';
import { releaseControls } from '../../src/client/ui/studio/studio-state.js';

describe('Studio release controls', () => {
	it('permits Preview and Review from the personal workbench', () => {
		expect(
			releaseControls({
				busy: false,
				accepting: true,
				hasRelease: true
			})
		).toEqual({ canPreview: true, canRequestReview: true, canRollback: true });
	});

	it('disables every operation while another command is running', () => {
		expect(
			releaseControls({
				busy: true,
				accepting: true,
				hasRelease: true
			})
		).toMatchObject({ canPreview: false, canRequestReview: false, canRollback: false });
	});
});
