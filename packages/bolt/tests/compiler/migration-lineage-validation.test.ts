import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { defineModel, text } from '../../src/authoring/index.js';
import type { ModelDeclaration } from '../../src/authoring/models-schema.js';
import type { RelationDefinition } from '../../src/authoring/workspace-schema.js';
import { workspaceSchemaFingerprint } from '../../src/compiler/schema-fingerprint.js';
import {
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

	it('rejects authored models that are ahead of the latest committed snapshot', async () => {
		const committed = currentModels();
		const { root } = await committedWorkspace(committed);
		const changed = {
			tickets: defineModel({ subject: text(), resolution: text() }, { recordLabel: 'subject' })
		};

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models: changed, relations: [] })
			)
		).rejects.toThrow('do not agree with the latest committed migration snapshot');
	});

	it('returns the snapshot fingerprint when authored and committed schema agree', async () => {
		const models = currentModels();
		const { root, snapshot } = await committedWorkspace(models);
		const schemaFingerprint = workspaceSchemaFingerprint(snapshot, []);

		await expect(
			Effect.runPromise(
				validateWorkspaceMigrationLineage({ workspaceRoot: root, models, relations: [] })
			)
		).resolves.toEqual({ snapshot, schemaFingerprint });
	});
});
