import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, text } from '../../src/authoring/index.js';
import type { ModelDeclaration } from '../../src/authoring/models-schema.js';
import type { RelationDefinition } from '../../src/authoring/workspace-schema.js';
import {
	advanceMutationCompatibilityLedger,
	mutationSchemaDescriptor,
	readMutationCompatibilityLedger,
	writeMutationCompatibilityLedger
} from '../../src/compiler/mutation-schema-compatibility.js';
import {
	generateWorkspaceMigration,
	importWorkspaceModels,
	planWorkspaceMigration,
	validateWorkspaceMigrationLineage,
	writeMigration,
	type WorkspaceSnapshot
} from '../../src/compiler/schema-migrations.js';

const validationRoots = new Set<string>();

afterEach(async () => {
	await Promise.all([...validationRoots].map((root) => rm(root, { recursive: true, force: true })));
	validationRoots.clear();
});

const currentModels = (): Readonly<Record<string, ModelDeclaration>> => ({
	tickets: defineModel({ subject: text() }, { recordLabel: 'subject' })
});

const committedWorkspace = async (
	models: Readonly<Record<string, ModelDeclaration>>,
	relations: ReadonlyArray<RelationDefinition> = []
): Promise<Readonly<{ root: string; snapshot: WorkspaceSnapshot }>> => {
	const root = await mkdtemp(join(tmpdir(), 'bolt-lineage-validation-'));
	validationRoots.add(root);
	const migration = await Effect.runPromise(
		planWorkspaceMigration({ models, relations, previous: undefined, name: 'baseline' })
	);
	if (migration === undefined) throw new Error('a baseline must produce a snapshot');
	await Effect.runPromise(
		writeMigration(join(root, '.norbital', 'migrations'), {
			...migration,
			tag: '20260827000000_baseline'
		})
	);
	return { root, snapshot: migration.snapshot };
};

const writeCurrentCompatibility = async (
	root: string,
	snapshot: WorkspaceSnapshot,
	relations: ReadonlyArray<RelationDefinition> = []
) => {
	const ledger = advanceMutationCompatibilityLedger({
		previous: undefined,
		schema: mutationSchemaDescriptor(snapshot, relations),
		statements: [],
		atEpochMs: 1
	});
	await Effect.runPromise(writeMutationCompatibilityLedger(root, ledger));
	return ledger;
};

describe('sync migration-lineage validation', () => {
	it('reimports an edited model in a long-lived process instead of reusing its ESM cache entry', async () => {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
		const root = await mkdtemp(join(packageRoot, '.lineage-validation-'));
		validationRoots.add(root);
		const modelDirectory = join(root, 'src', 'collections', 'tickets');
		const modelFile = join(modelDirectory, '+model.ts');
		await mkdir(modelDirectory, { recursive: true });
		const authoringEntry = pathToFileURL(join(packageRoot, 'src', 'authoring', 'index.ts')).href;
		await writeFile(
			modelFile,
			`import { defineModel, text } from ${JSON.stringify(authoringEntry)};\nexport default defineModel({ subject: text() });\n`,
			'utf8'
		);
		const first = await Effect.runPromise(importWorkspaceModels([modelFile]));
		expect(Object.keys(first['tickets']?.columns ?? {})).toEqual(['subject']);

		await writeFile(
			modelFile,
			`import { defineModel, text } from ${JSON.stringify(authoringEntry)};\nexport default defineModel({ resolution: text() });\n`,
			'utf8'
		);
		const second = await Effect.runPromise(importWorkspaceModels([modelFile]));
		expect(Object.keys(second['tickets']?.columns ?? {})).toEqual(['resolution']);
	});

	it('rejects a committed snapshot with no mutation compatibility ledger', async () => {
		const models = currentModels();
		const { root } = await committedWorkspace(models);

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models, relations: [] })
			)
		).rejects.toThrow('Mutation compatibility lineage is missing. Run `bolt migrate`');
	});

	it('rejects authored models that are ahead of the latest committed snapshot', async () => {
		const committed = currentModels();
		const { root, snapshot } = await committedWorkspace(committed);
		await writeCurrentCompatibility(root, snapshot);
		const changed = {
			tickets: defineModel({ subject: text(), resolution: text() }, { recordLabel: 'subject' })
		};

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models: changed, relations: [] })
			)
		).rejects.toThrow('do not agree with the latest committed migration snapshot');
	});

	it('returns the validated ledger when authored and committed schema agree', async () => {
		const models = currentModels();
		const { root, snapshot } = await committedWorkspace(models);
		const ledger = await writeCurrentCompatibility(root, snapshot);

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models, relations: [] })
			)
		).resolves.toEqual({ snapshot, mutationCompatibilityLedger: ledger });
	});

	it('rejects a compatibility ledger whose current checkpoint describes another schema', async () => {
		const models = currentModels();
		const { root } = await committedWorkspace(models);
		const staleSnapshot = (await committedWorkspace({ tickets: defineModel({ legacy: text() }) }))
			.snapshot;
		await writeCurrentCompatibility(root, staleSnapshot);

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models, relations: [] })
			)
		).rejects.toThrow('Mutation compatibility lineage does not match');
	});
});

describe('compatibility-only migration generation', () => {
	it('reports the first compatibility-ledger write without inventing a SQL migration', async () => {
		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
		const root = await mkdtemp(join(packageRoot, '.lineage-validation-'));
		validationRoots.add(root);
		try {
			const modelDirectory = join(root, 'src', 'collections', 'tickets');
			await mkdir(modelDirectory, { recursive: true });
			const authoringEntry = pathToFileURL(join(packageRoot, 'src', 'authoring', 'index.ts')).href;
			await writeFile(
				join(modelDirectory, '+model.ts'),
				`import { defineModel, text } from ${JSON.stringify(authoringEntry)};\nexport default defineModel({ subject: text() }, { recordLabel: 'subject' });\n`,
				'utf8'
			);
			await writeFile(join(root, 'src', '+agents.md'), 'Fixture workspace agent.\n', 'utf8');
			const models = currentModels();
			const baseline = await Effect.runPromise(
				planWorkspaceMigration({ models, relations: [], previous: undefined })
			);
			if (baseline === undefined) throw new Error('a baseline must produce a snapshot');
			await Effect.runPromise(
				writeMigration(join(root, '.norbital', 'migrations'), {
					...baseline,
					tag: '20260827000000_baseline'
				})
			);

			const first = await Effect.runPromise(generateWorkspaceMigration(root));
			expect(first).toMatchObject({
				migrationsRoot: join(root, '.norbital', 'migrations'),
				statements: [],
				compatibilityLedgerWritten: true
			});
			expect(first).not.toHaveProperty('tag');
			expect(
				await readFile(join(first.migrationsRoot, 'mutation-compatibility.json'), 'utf8')
			).toContain('"currentSchemaFingerprint": "sha256:');
			expect((await readdir(first.migrationsRoot)).toSorted()).toEqual([
				'20260827000000_baseline',
				'mutation-compatibility.json'
			]);

			const second = await Effect.runPromise(generateWorkspaceMigration(root));
			expect(second).toMatchObject({ statements: [], compatibilityLedgerWritten: false });
			expect(await Effect.runPromise(readMutationCompatibilityLedger(root))).toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
			validationRoots.delete(root);
		}
	});
});
