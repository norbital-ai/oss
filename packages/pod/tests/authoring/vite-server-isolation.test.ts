import { afterEach, describe, expect, it } from 'vitest';
import { pod } from '../../src/vite/index.js';

const originalBuildTarget = process.env.NORBITAL_POD_BUILD_TARGET;
const originalIsolatedBuild = process.env.NORBITAL_POD_ISOLATED_BUILD;

afterEach(() => {
	if (originalBuildTarget == null) delete process.env.NORBITAL_POD_BUILD_TARGET;
	else process.env.NORBITAL_POD_BUILD_TARGET = originalBuildTarget;
	if (originalIsolatedBuild == null) delete process.env.NORBITAL_POD_ISOLATED_BUILD;
	else process.env.NORBITAL_POD_ISOLATED_BUILD = originalIsolatedBuild;
});

describe('isolated Vite server process', () => {
	it('does not instantiate client plugin factories', () => {
		process.env.NORBITAL_POD_BUILD_TARGET = 'server';
		process.env.NORBITAL_POD_ISOLATED_BUILD = '1';

		const plugins = pod();

		expect(plugins).toHaveLength(1);
		expect(plugins[0]).toMatchObject({ name: 'norbital-pod-build' });
	});
});
