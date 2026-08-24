import { describe, expect, it } from 'vitest';
import { currentRoutedRelease, type MatrixEntry } from '../../src/client/ui/studio/studio-state.js';

const route = (environmentId: string, releaseId: string): MatrixEntry => ({
	tenantId: 'tenant-1',
	environmentId,
	releaseId,
	artifactId: releaseId === '' ? '' : `artifact-${releaseId}`,
	health: 'ready',
	ownerEpoch: 'colony'
});

describe('Operations current release', () => {
	it('summarizes a configured routed environment without requiring it to be named live', () => {
		expect(currentRoutedRelease([route('development', 'release-development')])).toMatchObject({
			environmentId: 'development',
			releaseId: 'release-development'
		});
	});

	it('prefers Live when the host reports more than one routed environment', () => {
		expect(
			currentRoutedRelease([
				route('preview-alice', 'release-preview'),
				route('live', 'release-live')
			])
		).toMatchObject({ environmentId: 'live', releaseId: 'release-live' });
	});

	it('keeps an unrouted environment in the empty state', () => {
		expect(currentRoutedRelease([route('development', '')])).toBeUndefined();
	});
});
