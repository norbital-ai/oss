import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderArtifact, discoverAuthoredSource } from '../../src/compiler/workspace-build.js';

/**
 * `src/+agents.md`, from the file an author writes to the artifact a runtime boots.
 *
 * It replaces `src/+agent.ts`, and the way it replaces it is the point. The compiler synthesized
 * `{ name, prompt: 'You are the <workspace> workspace agent.', tools, skills }` and discovered no
 * `+agent.ts` at all — so `hr-payroll`, the one workspace that authored a scoped, write-capable
 * agent with a real operating prompt and a raised token budget, shipped an unscoped one that had
 * read none of it. Nothing failed anywhere, which is why it stood for as long as it did.
 *
 * There is now no placeholder to fall back to, because the placeholder *was* the defect: five of six
 * workspaces shipped it, including both of the two whose agents were reachable from outside. A
 * workspace without the file does not compile.
 */

const root = '/workspace';

const artifactWithPrompt = (prompt: string): string =>
	renderArtifact({
		metadata: { name: 'fixture', version: '1.0.0', description: 'Bolt workspace' },
		collections: [
			{
				name: 'orders',
				path: `${root}/src/collections/orders/+model.ts`,
				sourcePath: 'src/collections/orders/+model.ts',
				fields: { title: { type: 'string', required: true, indexed: false } }
			}
		],
		relations: [],
		apps: [],
		policies: [],
		functions: [],
		toolFiles: [],
		envoyFiles: [],
		automations: [],
		automationFiles: [],
		pipelineFiles: [],
		skills: [],
		prompt,
		root,
		assetIndex: { browser: [], server: [] },
		customTypeDefinitions: [],
		environmentFile: undefined,
		migrations: [],
		schemaFingerprint: 'sha256:fixture',
		integrationFiles: []
	});

/**
 * The declared workspace the artifact actually boots with, executed rather than grepped.
 *
 * A test that matches the spelling of a line passes on the spelling. This runs the emitted literal,
 * so it passes only if the prompt is genuinely in the descriptor the runtime reads.
 */
const declaredWorkspace = (artifact: string): Record<string, unknown> => {
	const start = artifact.indexOf('const declaredWorkspace = ');
	const end = artifact.indexOf('\n};\n', start) + '\n};'.length;
	if (start < 0) throw new Error('the artifact no longer declares a workspace literal');
	return new Function(`${artifact.slice(start, end)}\nreturn declaredWorkspace;`)() as Record<
		string,
		unknown
	>;
};

describe('the workspace system prompt', () => {
	it('carries src/+agents.md verbatim into the declared workspace', () => {
		const prompt = '# The orders desk\n\nAnswer only from records you actually read.\n';
		expect(declaredWorkspace(artifactWithPrompt(prompt))['prompt']).toBe(prompt);
	});

	/**
	 * A prompt is prose, and prose contains backticks, quotes and `${`.
	 *
	 * The descriptor is emitted as a JSON literal inside a template string, so a prompt that closed
	 * the template or opened an interpolation would produce an artifact that fails to parse — a
	 * failure that looks like a broken compiler rather than like a punctuation mark in a sentence.
	 */
	it('survives a prompt containing backticks, quotes and an interpolation', () => {
		const prompt = 'Use `read_collection`. Never say "done" unless ${it} is. \\ backslash.';
		expect(declaredWorkspace(artifactWithPrompt(prompt))['prompt']).toBe(prompt);
	});

	it('declares no agents array at all — the web agent has no declaration', () => {
		const declared = declaredWorkspace(artifactWithPrompt('Be helpful.'));
		expect(declared['agents']).toBeUndefined();
		expect(declared['envoys']).toEqual([]);
	});

	/**
	 * A workspace with no prompt is refused, by name, at discovery.
	 *
	 * This is the assertion that would fail on the old shape: a placeholder is a valid artifact, so
	 * the only way to know the file was missing was to read the compiled prompt and recognise the
	 * sentence.
	 */
	it('refuses a workspace that has no src/+agents.md', async () => {
		const workspaceRoot = await mkdtemp(join(tmpdir(), 'bolt-prompt-'));
		try {
			await mkdir(join(workspaceRoot, 'src', 'collections', 'orders'), { recursive: true });
			await writeFile(
				join(workspaceRoot, 'src', 'collections', 'orders', '+model.ts'),
				'export default {};\n'
			);
			await expect(Effect.runPromise(discoverAuthoredSource(workspaceRoot))).rejects.toThrow(
				/\+agents\.md/
			);
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});

	/** An empty file is the same absence wearing a filename. */
	it('refuses an empty src/+agents.md', async () => {
		const workspaceRoot = await mkdtemp(join(tmpdir(), 'bolt-prompt-'));
		try {
			await mkdir(join(workspaceRoot, 'src', 'collections', 'orders'), { recursive: true });
			await writeFile(
				join(workspaceRoot, 'src', 'collections', 'orders', '+model.ts'),
				'export default {};\n'
			);
			await writeFile(join(workspaceRoot, 'src', '+agents.md'), '   \n');
			await expect(Effect.runPromise(discoverAuthoredSource(workspaceRoot))).rejects.toThrow(
				/empty/
			);
		} finally {
			await rm(workspaceRoot, { recursive: true, force: true });
		}
	});
});
