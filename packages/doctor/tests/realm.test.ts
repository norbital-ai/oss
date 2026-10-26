/** The realm import-boundary pack over the real package graph. */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { doctor } from '../build/index.js';

const OSS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

it.effect('the realm boundaries pack reports nothing over the oss packages', () =>
	Effect.sync(() => {
		assert.deepEqual(
			doctor({ root: OSS, packs: ['realm/boundaries'] }).map((finding) => finding.location),
			[]
		);
	})
);
