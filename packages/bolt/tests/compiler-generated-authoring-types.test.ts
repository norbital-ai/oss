import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAuthoringTypes, renderWorkspaceAuthoring } from '../src/compiler/workspace-build.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const diagnosticText = (diagnostic: ts.Diagnostic): string => {
	const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
	if (!diagnostic.file || diagnostic.start === undefined) return message;
	const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
	return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
};

describe('generated authoring unions', () => {
	/**
	 * A real `ts.createProgram` plus `getPreEmitDiagnostics`, not a string assertion.
	 *
	 * That is the point of the test — the generated unions are only proved by type-checking them —
	 * but it is also a second of compiler work on a developer machine, and vitest's five-second
	 * default left almost no margin for it. A loaded CI runner crossed that line and failed the
	 * release with a timeout while all 679 other tests passed. The budget is stated here so the
	 * next slow runner reports a real regression rather than the scheduler.
	 */
	it(
		'keeps team names and app group prefixes exact without circular workspace types',
		{ timeout: 30_000 },
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'bolt-authoring-types-'));
			roots.push(root);
			await mkdir(join(root, 'src', 'access'), { recursive: true });
			await mkdir(join(root, '.norbital', 'generated'), { recursive: true });
			await mkdir(join(root, '.norbital', 'types'), { recursive: true });

			await writeFile(
				join(root, 'src', 'access', '+teams.ts'),
				`import type { Teams } from '@norbital-ai/bolt/authoring';
export default {
	Operations: ['operator'],
	Reviewers: []
} satisfies Teams;
`
			);
			await writeFile(
				join(root, '.norbital', 'generated', 'authoring-types.ts'),
				renderAuthoringTypes({
					collections: ['records'],
					apps: ['hr_controller/leave'],
					policies: ['operator'],
					functions: [],
					tools: [],
					envoys: [],
					mcpServers: [],
					skills: [],
					datatypes: [],
					automations: [],
					teamsImport: '../../src/access/+teams.js'
				})
			);
			await writeFile(
				join(root, '.norbital', 'generated', 'types.ts'),
				`export type WorkspaceSchema = {
	readonly tables: {
		readonly records: {
			readonly $inferSelect: { readonly id: string; readonly visible: string; readonly secret: string; readonly row_version: number };
			readonly $inferInsert: { readonly visible: string; readonly secret?: string };
			readonly $references?: Record<never, never>;
		};
	};
	readonly relations: Record<never, never>;
};
`
			);
			await writeFile(
				join(root, '.norbital', 'types', 'workspace-authoring.d.ts'),
				renderWorkspaceAuthoring()
			);
			await writeFile(
				join(root, 'src', 'witness.ts'),
				`import { approveBy, noApproval, type Api, type AppName, type PolicyDefinition, type TeamName } from '@norbital-ai/bolt/authoring';
import type { WorkspaceSchema } from '../.norbital/generated/types.js';
const valid: TeamName = 'Reviewers';
// @ts-expect-error -- a generated team union must still reject misspellings.
const typo: TeamName = 'Reviewer';
const appGroup: AppName = 'hr_controller';
const appLeaf: AppName = 'hr_controller/leave';
// @ts-expect-error -- a directory grant remains a generated union, not an arbitrary string.
const appGroupTypo: AppName = 'hr_controllers';
export default {
	description: 'Operator writes require review.',
	capabilities: { apps: [appGroup] },
	grants: {
		records: {
			mutate: {
				new: {
					fields: ['id', 'visible'],
					authorize: ({ record }, api) => {
						const id: string = record.id;
						const visible: string = record.visible;
						// @ts-expect-error -- database-generated columns are absent from a prepared new-row mutation.
						void record.row_version;
						void api.db.records.findMany;
						void api.requestor.id;
						void id;
						return visible.length > 0;
					},
					approval: {
						flow: ({ record }, api) => {
							const visible: string = record.visible;
							void api.db.records.findMany;
							// @ts-expect-error -- the condition row is this grant's generated collection row.
							void record.missing;
							// @ts-expect-error -- policy decisions receive reads only, never mutation methods.
							void api.db.records.mutate;
							return visible === 'review' ? approveBy(valid) : noApproval;
						},
						superceded_by: [valid]
					}
				},
				existing: {
					authorize: ({ previous, changes, record }) => {
						const priorVersion: number = previous.row_version;
						const nextVersion: number = record.row_version;
						const changedVisible: string | undefined = changes.visible;
						void priorVersion;
						void nextVersion;
						void changedVisible;
						return true;
					}
				}
			}
		}
	}
} satisfies PolicyDefinition;
declare const api: Api<WorkspaceSchema>;
void api.db.records.findMany({ where: { visible: { eq: 'open' } } });
void api.db.records.mutate([{ visible: 'open' }]);
void api.db.records.mutate([{ id: 'record-id', visible: 'closed' }]);
const invalidFieldPolicy = {
	description: 'A field mask must name a real row field.',
	grants: { records: { read: { fields: [
			// @ts-expect-error -- field masks are generated from this collection's row.
			'missing'
		] } } }
} satisfies PolicyDefinition;
const removedCreateGrant = {
	description: 'Removed create spelling.',
	grants: { records: {
		// @ts-expect-error -- collection grants expose mutate.new, never create.
		create: {}
	} }
} satisfies PolicyDefinition;
const removedUpdateGrant = {
	description: 'Removed update spelling.',
	grants: { records: {
		// @ts-expect-error -- collection grants expose mutate.existing, never update.
		update: {}
	} }
} satisfies PolicyDefinition;
void typo;
void appLeaf;
void appGroupTypo;
void invalidFieldPolicy;
void removedCreateGrant;
void removedUpdateGrant;
`
			);

			const authoringSource = fileURLToPath(new URL('../src/authoring/index.ts', import.meta.url));
			const program = ts.createProgram({
				rootNames: [
					join(root, 'src', 'access', '+teams.ts'),
					join(root, 'src', 'witness.ts'),
					join(root, '.norbital', 'generated', 'authoring-types.ts'),
					join(root, '.norbital', 'generated', 'types.ts'),
					join(root, '.norbital', 'types', 'workspace-authoring.d.ts')
				],
				options: {
					allowSyntheticDefaultImports: true,
					baseUrl: root,
					esModuleInterop: true,
					ignoreDeprecations: '6.0',
					lib: ['lib.es2024.d.ts', 'lib.dom.d.ts'],
					module: ts.ModuleKind.ESNext,
					moduleResolution: ts.ModuleResolutionKind.Bundler,
					noEmit: true,
					paths: {
						'@norbital-ai/bolt/authoring': [relative(root, authoringSource)]
					},
					skipLibCheck: true,
					strict: true,
					target: ts.ScriptTarget.ES2022
				}
			});

			const workspaceDiagnostics = ts
				.getPreEmitDiagnostics(program)
				.filter((diagnostic) => diagnostic.file?.fileName.startsWith(root));
			expect(workspaceDiagnostics.map(diagnosticText)).toEqual([]);
		}
	);
});
