import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workspaceContainerCreateArguments } from '../lib/builder-benchmark.mjs';

describe('builder benchmark container isolation', () => {
	it('creates the sync and build containers under their distinct requested names', () => {
		const common = {
			image: 'registry.example.test/norbital-builder@sha256:' + 'a'.repeat(64),
			platformDirectory: '/opt/norbital/platform-client'
		};
		const buildName = 'norbital-builder-benchmark-123';
		const syncName = `${buildName}-sync`;
		const syncArguments = workspaceContainerCreateArguments({ ...common, name: syncName });
		const buildArguments = workspaceContainerCreateArguments({ ...common, name: buildName });

		assert.equal(syncArguments[syncArguments.indexOf('--name') + 1], syncName);
		assert.equal(buildArguments[buildArguments.indexOf('--name') + 1], buildName);
		assert.notDeepEqual(syncArguments, buildArguments);
	});
});
