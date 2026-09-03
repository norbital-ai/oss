import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPublicSeed } from '../src/load-public-seed.ts';
import { simpleWorkspace } from '../src/simple-workspace.ts';
import { jsonSqlParameter, withSelfHost } from '../src/with-self-host.ts';

const fixtureBundlePath = fileURLToPath(
	new URL('../../bolt-server/tests/fixtures/fixture-bundle.mjs', import.meta.url)
);

const LOCAL_DATABASE_TEST_TIMEOUT_MILLIS = 60_000;

const isConnectionRefused = (error: unknown): boolean => {
	if (!(error instanceof Error)) return false;
	if ('code' in error && (error as { readonly code?: unknown }).code === 'ECONNREFUSED') {
		return true;
	}
	const cause = (error as { readonly cause?: unknown }).cause;
	return cause !== undefined && isConnectionRefused(cause);
};

describe('jsonSqlParameter', () => {
	it('keeps JS arrays and stringifies only non-array objects', () => {
		assert.deepEqual(jsonSqlParameter(['a', 'b']), ['a', 'b']);
		assert.equal(jsonSqlParameter({ a: 1 }), '{"a":1}');
		assert.equal(jsonSqlParameter('plain'), 'plain');
		assert.equal(jsonSqlParameter(3), 3);
		assert.equal(jsonSqlParameter(null), null);
	});
});

describe('withSelfHost (T2)', () => {
	it(
		'starts PGlite, seeds a public tree, migrates the fixture guest, and answers /readyz',
		{ timeout: LOCAL_DATABASE_TEST_TIMEOUT_MILLIS },
		async () => {
			// The fixture bundle has no identity.bootstrapFounder (unknown commands echo 200).
			// schemaPlan.steps is empty, so the notes relation is created here before INSERT.
			await withSelfHost(
				{
					bundlePath: fixtureBundlePath,
					tenantId: 'test-utilities-t2',
					founder: false
				},
				async (session) => {
					assert.equal(session.credential, undefined);
					assert.equal(session.tenantId, 'test-utilities-t2');
					assert.equal(session.gatewaySecret, 'test-utilities-t2-gateway');
					assert.notEqual(session.address.port, 0);

					const ready = await fetch(`${session.baseUrl}/readyz`);
					assert.equal(ready.status, 200);
					const snapshot = (await ready.json()) as { readonly ready?: unknown };
					assert.equal(snapshot.ready, true);

					await session.query('create table notes (id text primary key, body text)');
					await loadPublicSeed({
						stages: simpleWorkspace.stages,
						rows: simpleWorkspace.rows,
						query: session.query
					});
					const seeded = await session.query('select id, body from notes order by id');
					assert.deepEqual(seeded, [{ id: 'note-1', body: 'hello' }]);
				}
			);
		}
	);

	it(
		'stops the host when the body throws',
		{ timeout: LOCAL_DATABASE_TEST_TIMEOUT_MILLIS },
		async () => {
			let baseUrl: string | undefined;
			await assert.rejects(
				() =>
					withSelfHost(
						{
							bundlePath: fixtureBundlePath,
							tenantId: 'test-utilities-t2-stop',
							founder: false
						},
						async (session) => {
							baseUrl = session.baseUrl;
							const ready = await fetch(`${session.baseUrl}/readyz`);
							assert.equal(ready.status, 200);
							throw new Error('withSelfHost body failed');
						}
					),
				(error: unknown) =>
					error instanceof Error && error.message === 'withSelfHost body failed'
			);
			assert.ok(baseUrl !== undefined);
			await assert.rejects(() => fetch(`${baseUrl}/readyz`), isConnectionRefused);
		}
	);
});
