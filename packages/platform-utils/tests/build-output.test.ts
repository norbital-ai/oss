import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	CHECKPOINT_BUILD_FORMAT,
	checkpointBuildContractId,
	checkpointBuilderVersion,
	checkpointPackageKey,
	LEGACY_CHECKPOINT_BUILD_FORMAT,
	parseCheckpointBuilderVersion
} from '../src/tenant_workspace/build-output.ts';

describe('checkpoint build identity', () => {
	it('round-trips a current immutable platform build contract', () => {
		const buildContractId = 'a'.repeat(64);
		const builderVersion = checkpointBuilderVersion(buildContractId);

		assert.equal(builderVersion, `vite-2-${buildContractId}`);
		assert.deepEqual(parseCheckpointBuilderVersion(builderVersion), {
			format: CHECKPOINT_BUILD_FORMAT,
			buildContractId
		});
		assert.equal(checkpointBuildContractId(builderVersion), buildContractId);
		assert.throws(() => checkpointPackageKey(builderVersion), /platform release/);
	});

	it('continues to parse retained package-only checkpoints', () => {
		const packageKey = '0123456789abcdef';
		const builderVersion = `vite-1-${packageKey}`;

		assert.deepEqual(parseCheckpointBuilderVersion(builderVersion), {
			format: LEGACY_CHECKPOINT_BUILD_FORMAT,
			packageKey
		});
		assert.equal(checkpointPackageKey(builderVersion), packageKey);
		assert.throws(() => checkpointBuildContractId(builderVersion), /no platform build contract/);
	});

	it('rejects malformed current and legacy identities', () => {
		assert.throws(
			() => checkpointBuilderVersion('a'.repeat(63)),
			/Invalid platform build contract/
		);
		assert.throws(() => parseCheckpointBuilderVersion('vite-2-not-a-digest'));
		assert.throws(() => parseCheckpointBuilderVersion('vite-1-not-a-key'));
		assert.throws(() => parseCheckpointBuilderVersion('webpack-1-0123456789abcdef'));
	});
});
