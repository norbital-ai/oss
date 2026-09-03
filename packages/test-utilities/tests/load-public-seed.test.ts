import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadPublicSeed, PublicSeedBankPathError } from '../src/load-public-seed.ts';

const unusedQuery = async (): Promise<unknown> => {
	throw new Error('query must not run on the Phase 0 refuse path');
};

const withBankRoot = async (root: string, body: () => Promise<void>): Promise<void> => {
	const previous = process.env.NORBITAL_SEED_BANK_ROOT;
	process.env.NORBITAL_SEED_BANK_ROOT = root;
	try {
		await body();
	} finally {
		if (previous === undefined) delete process.env.NORBITAL_SEED_BANK_ROOT;
		else process.env.NORBITAL_SEED_BANK_ROOT = previous;
	}
};

describe('loadPublicSeed', () => {
	it('refuses a directory under seed_bank/', async () => {
		await assert.rejects(
			() =>
				loadPublicSeed({
					stages: ['people'],
					rows: '/tmp/checkout/seed_bank/acme',
					query: unusedQuery
				}),
			(error: unknown) =>
				error instanceof PublicSeedBankPathError &&
				error.sourcePath === '/tmp/checkout/seed_bank/acme'
		);
	});

	it('refuses a relative seed_bank/ source', async () => {
		await assert.rejects(
			() =>
				loadPublicSeed({
					stages: ['people'],
					rows: '../seed_bank/acme',
					query: unusedQuery
				}),
			(error: unknown) => error instanceof PublicSeedBankPathError
		);
	});

	it('refuses a stage that names a bank path', async () => {
		await assert.rejects(
			() =>
				loadPublicSeed({
					stages: ['seed_bank/acme'],
					rows: { people: [{ id: 'pub-1' }] },
					query: unusedQuery
				}),
			(error: unknown) => error instanceof PublicSeedBankPathError
		);
	});

	it('refuses when NORBITAL_SEED_BANK_ROOT is the source directory', async () => {
		const bankRoot = mkdtempSync(join(tmpdir(), 'public-seed-bank-'));
		await withBankRoot(bankRoot, async () => {
			await assert.rejects(
				() =>
					loadPublicSeed({
						stages: ['people'],
						rows: bankRoot,
						query: unusedQuery
					}),
				(error: unknown) =>
					error instanceof PublicSeedBankPathError && error.sourcePath === bankRoot
			);
		});
	});

	it('refuses a path under NORBITAL_SEED_BANK_ROOT', async () => {
		const bankRoot = mkdtempSync(join(tmpdir(), 'public-seed-bank-'));
		await withBankRoot(bankRoot, async () => {
			await assert.rejects(
				() =>
					loadPublicSeed({
						stages: ['people'],
						rows: join(bankRoot, 'world'),
						query: unusedQuery
					}),
				(error: unknown) => error instanceof PublicSeedBankPathError
			);
		});
	});

	it('does not treat NORBITAL_SEED_BANK_ROOT as a default location', async () => {
		const bankRoot = mkdtempSync(join(tmpdir(), 'public-seed-bank-'));
		const statements: string[] = [];
		await withBankRoot(bankRoot, async () => {
			await loadPublicSeed({
				stages: ['people'],
				rows: { people: [{ id: 'pub-1' }] },
				query: async (statement) => {
					statements.push(statement);
				}
			});
		});
		assert.equal(statements.length, 1);
		assert.match(statements[0] ?? '', /INSERT INTO "people"/);
	});

	it('inserts an in-memory public tree through query in stage order', async () => {
		const calls: Array<{ readonly statement: string; readonly parameters: readonly unknown[] }> =
			[];
		await loadPublicSeed({
			stages: ['authors', 'notes'],
			rows: {
				authors: [{ id: 'a-1', name: 'Ada' }],
				notes: [{ id: 'n-1', body: 'hello' }]
			},
			query: async (statement, parameters) => {
				calls.push({ statement, parameters: [...(parameters ?? [])] });
			}
		});
		assert.deepEqual(
			calls.map((call) => call.statement),
			[
				'INSERT INTO "authors" ("id", "name") VALUES ($1, $2)',
				'INSERT INTO "notes" ("id", "body") VALUES ($1, $2)'
			]
		);
		assert.deepEqual(
			calls.map((call) => call.parameters),
			[
				['a-1', 'Ada'],
				['n-1', 'hello']
			]
		);
	});

	it('refuses a public row that has no id', async () => {
		await assert.rejects(
			() =>
				loadPublicSeed({
					stages: ['notes'],
					rows: { notes: [{ body: 'missing-id' }] },
					query: unusedQuery
				}),
			(error: unknown) => error instanceof Error && /requires id/.test(error.message)
		);
	});
});
