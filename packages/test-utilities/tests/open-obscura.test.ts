import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guestUrlForObscura, startObscura } from '../src/open-obscura.ts';

const withObscuraEnv = async (
	values: Readonly<Record<string, string | undefined>>,
	body: () => Promise<void>
): Promise<void> => {
	const keys = ['OBSCURA_CDP_URL', 'COLONY_BROWSER_CDP_URL'] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) {
		const value = values[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

describe('startObscura', () => {
	it('returns a configured URL without starting a process', async () => {
		await withObscuraEnv(
			{ OBSCURA_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser', COLONY_BROWSER_CDP_URL: undefined },
			async () => {
				const started = await startObscura();
				assert.equal(started.endpoint, 'ws://127.0.0.1:9222/devtools/browser');
				assert.equal(started.source, 'url');
				await started.stop();
			}
		);
	});

	it('prefers an explicit URL over env', async () => {
		await withObscuraEnv(
			{ OBSCURA_CDP_URL: 'ws://env.example/devtools/browser', COLONY_BROWSER_CDP_URL: undefined },
			async () => {
				const started = await startObscura('ws://explicit.example/devtools/browser');
				assert.equal(started.endpoint, 'ws://explicit.example/devtools/browser');
				assert.equal(started.source, 'url');
				await started.stop();
			}
		);
	});

	it('rewrites loopback guests for Docker Obscura', () => {
		assert.equal(
			guestUrlForObscura('127.0.0.1', 4317, '/readyz'),
			'http://host.docker.internal:4317/readyz'
		);
		assert.equal(
			guestUrlForObscura('0.0.0.0', 80, 'readyz'),
			'http://host.docker.internal:80/readyz'
		);
		assert.equal(
			guestUrlForObscura('127.0.0.1', 4317, '/readyz', { rewriteLoopback: false }),
			'http://127.0.0.1:4317/readyz'
		);
		assert.equal(
			guestUrlForObscura('10.0.0.4', 4317, '/readyz'),
			'http://10.0.0.4:4317/readyz'
		);
	});
});
