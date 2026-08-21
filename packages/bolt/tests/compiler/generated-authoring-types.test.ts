import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { renderAuthoringTypes, renderWorkspaceAuthoring } from '../../src/compiler/sync.js';

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
	it('keeps team names and app group prefixes exact without circular workspace types', async () => {
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
			`import type { AnySchema } from '@norbital-ai/bolt/authoring';
export type WorkspaceSchema = AnySchema;
`
		);
		await writeFile(
			join(root, '.norbital', 'types', 'workspace-authoring.d.ts'),
			renderWorkspaceAuthoring()
		);
		await writeFile(
			join(root, 'src', 'witness.ts'),
			`import type { AppName, PolicyDefinition, TeamName } from '@norbital-ai/bolt/authoring';
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
	grants: [{
		collection: 'records',
		action: 'create',
		approval: { steps: [{ key: 'review', approvers: [valid] }] }
	}]
} satisfies PolicyDefinition;
void typo;
void appLeaf;
void appGroupTypo;
`
		);

		const authoringSource = fileURLToPath(new URL('../../src/authoring/index.ts', import.meta.url));
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
	});
});
