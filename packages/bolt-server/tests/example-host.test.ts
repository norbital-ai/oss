// The example host file `env serve` runs: Colony's settings with transcription and no speak model still load it.
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isOff } from '@norbital-ai/bolt/facilities';
import { loadHost } from '@norbital-ai/bolt/node';

const example = fileURLToPath(new URL('../example/norbital.host.ts', import.meta.url));

describe('example/norbital.host.ts', () => {
	it.live('loads with a transcribe model and no speak model, speech off', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped();
			const saved = { ...process.env };
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					process.env = saved;
				})
			);
			Object.assign(process.env, {
				BOLT_PUBLIC_URL: 'http://127.0.0.1:3100',
				BOLT_PGLITE_DIR: path.join(dir, 'db'),
				BOLT_AUDIT_DIR: path.join(dir, 'audit'),
				BOLT_MASTER_KEY: randomBytes(32).toString('hex'),
				BOLT_FILES_PROVIDER: 'local',
				BOLT_FILES_ENDPOINT: path.join(dir, 'files'),
				BOLT_TRANSACTIONAL_EMAIL: 'log',
				BOLT_AI_SPEECH_ENDPOINT: 'https://openrouter.ai/api/v1',
				BOLT_AI_SPEECH_CREDENTIAL: 'test',
				BOLT_AI_TRANSCRIBE_MODEL: 'google/gemini-3.8-flash'
			});
			const { facilities } = yield* loadHost(example);
			expect(isOff(facilities.intelligence.speech)).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
