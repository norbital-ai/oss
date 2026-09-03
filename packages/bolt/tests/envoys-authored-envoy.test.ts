import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import {
	envoy,
	type CompiledAuthoring
} from '../src/authoring/workspace-schema.js';
import { describeEnvoy } from '../src/authoring/policy-introspection.js';
import { renderArtifact } from '../src/compiler/workspace-build.js';

const root = '/workspace';
const compiledAuthoring = {
	collections: [],
	relationships: [],
	customTypeReferences: [],
	capabilities: { skills: [], mcp: [] }
} satisfies CompiledAuthoring;

const authoredModule = {
	transport: 'telegram',
	audience: 'public',
	policies: ['sales_rep'],
	groupMessages: 'disabled',
	delegation: 'disabled',
	task: 'Answer questions about quotes and accounts for this customer.'
} as const;

const renderInput = (envoyFiles: ReadonlyArray<string>) =>
	({
		metadata: { name: 'crm', version: '1.0.0', description: 'Bolt workspace' },
		compiledAuthoring,
		collectionHooks: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [],
		envoyFiles,
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		prompt: 'You are the crm workspace agent.',
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: [],
		schemaFingerprint: 'sha256:fixture'
	}) satisfies Parameters<typeof renderArtifact>[0];

const compileEnvoyDeclaration = () => {
	const artifact = renderArtifact(renderInput([`${root}/src/envoys/+sales_desk.ts`]));
	const declarationStart = artifact.indexOf('const declaredWorkspace = ');
	const mergeStart = artifact.indexOf('const envoys = declaredWorkspace.envoys.map(');
	if (declarationStart < 0 || mergeStart < 0) {
		throw new Error('the artifact no longer declares and merges envoys explicitly');
	}
	const mergeEnd = artifact.indexOf('\n', mergeStart);
	const declarationEnd = artifact.indexOf('\n};\n', declarationStart) + '\n};'.length;
	const source = `${artifact.slice(declarationStart, declarationEnd)}\n${artifact.slice(mergeStart, mergeEnd)}\nreturn envoys;`;
	const compiled = new Function('declaredEnvoys', 'describeEnvoy', source)(
		{ sales_desk: authoredModule },
		describeEnvoy
	) as ReadonlyArray<ReturnType<typeof describeEnvoy>>;
	const declaration = compiled[0];
	if (declaration === undefined) throw new Error('the compiler produced no envoy');
	return declaration;
};

describe('an authored Envoy declaration unit', () => {
	it('preserves the authored transport, audience, delegation, and Task instruction', () => {
		expect(compileEnvoyDeclaration()).toEqual({ name: 'sales_desk', ...authoredModule });
	});

	it('emits a parseable artifact that imports every Envoy module', () => {
		const artifact = renderArtifact(
			renderInput([`${root}/src/envoys/+sales_desk.ts`, `${root}/src/envoys/+member_desk.ts`])
		);
		expect(artifact).toContain('import envoy0 from "../../src/envoys/+sales_desk.js";');
		expect(artifact).toContain('import envoy1 from "../../src/envoys/+member_desk.js";');
		expect(artifact).toContain(
			'const declaredEnvoys = {"sales_desk": envoy0, "member_desk": envoy1};'
		);
		expect(() => parseAst(artifact)).not.toThrow();
	});

	it('rejects reserved names and incomplete authority declarations', () => {
		expect(() => envoy({ name: 'web', ...authoredModule })).toThrow(/reserved/);
		const missingDelegation = {
			transport: 'telegram',
			audience: 'public',
			policies: ['sales_rep'],
			groupMessages: 'disabled',
			task: 'Answer questions about quotes and accounts for this customer.'
		} as const;
		expect(() => describeEnvoy('sales_desk', missingDelegation)).toThrow(/valid envoy object/);
		expect(() => envoy({ name: 'sales_desk', ...missingDelegation } as never)).toThrow(
			/requires delegation/
		);
		expect(() => envoy({ ...authoredModule, name: 'sales_desk', policies: [] })).toThrow(
			/names no policies/
		);
	});
});
