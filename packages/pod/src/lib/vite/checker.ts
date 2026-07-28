import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { safeParse } from '@norbital-ai/std/json';

const SVELTE_CHECK_BIN = createRequire(import.meta.url).resolve('svelte-check/bin/svelte-check');

export interface CheckerDiagnostic {
	readonly source: 'typescript' | 'svelte' | 'checker';
	readonly severity: 'error';
	readonly code: string;
	readonly file: string;
	readonly start: { readonly line: number; readonly column: number };
	readonly message: string;
}

export interface PodWorkspaceCheckOptions {
	readonly mode: 'authoring' | 'build';
	readonly revision?: number;
	readonly isCurrent?: () => boolean;
}

export interface PodWorkspaceCheckResult {
	readonly valid: boolean;
	readonly published: boolean;
	readonly changed: boolean;
	readonly diagnostics: readonly CheckerDiagnostic[];
}

function checkerDiagnostic(line: string): CheckerDiagnostic | null {
	const jsonStart = line.indexOf('{');
	if (jsonStart === -1) return null;
	const value = safeParse(line.slice(jsonStart));
	if (!value || typeof value !== 'object') return null;
	const message = Reflect.get(value, 'message');
	const filename = Reflect.get(value, 'filename');
	if (typeof message !== 'string' || typeof filename !== 'string') return null;
	const source = Reflect.get(value, 'source');
	const start = Reflect.get(value, 'start');
	const lineNumber = start && typeof start === 'object' ? Reflect.get(start, 'line') : 0;
	const character = start && typeof start === 'object' ? Reflect.get(start, 'character') : 0;
	return {
		source: source === 'svelte' ? 'svelte' : 'typescript',
		severity: 'error',
		code: String(Reflect.get(value, 'code') ?? 'SVELTE_CHECK'),
		file: filename,
		start: {
			line: typeof lineNumber === 'number' ? lineNumber + 1 : 1,
			column: typeof character === 'number' ? character + 1 : 1
		},
		message
	};
}

export function parseSvelteCheckOutput(output: string): CheckerDiagnostic[] {
	return output
		.split(/\r?\n/)
		.map(checkerDiagnostic)
		.filter((diagnostic): diagnostic is CheckerDiagnostic => diagnostic !== null);
}

interface CheckerProcessResult {
	readonly exitCode: number;
	readonly error: Error | null;
	readonly stdout: string;
	readonly stderr: string;
}

async function runCheckerProcess(
	executable: string,
	args: readonly string[],
	root: string,
	env: NodeJS.ProcessEnv = process.env
): Promise<CheckerProcessResult> {
	const child = spawn(executable, args, {
		cwd: root,
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const result = await new Promise<{ readonly exitCode: number; readonly error: Error | null }>(
		(resolve) => {
			child.once('error', (error) => resolve({ exitCode: 1, error }));
			child.once('close', (code) => resolve({ exitCode: code ?? 1, error: null }));
		}
	);
	return { ...result, stdout, stderr };
}

function checkerFailure(
	code: string,
	label: string,
	result: CheckerProcessResult
): CheckerDiagnostic {
	return {
		source: 'checker',
		severity: 'error',
		code,
		file: 'tsconfig.json',
		start: { line: 1, column: 1 },
		message:
			result.error?.message ||
			result.stderr.trim() ||
			result.stdout.trim() ||
			`${label} exited with code ${result.exitCode}`
	};
}

async function publishCheckerDiagnostics(
	root: string,
	diagnostics: readonly CheckerDiagnostic[],
	options: PodWorkspaceCheckOptions
): Promise<boolean> {
	const file = path.join(root, '.norbital/diagnosis/diagnostics.json');
	const content = `${JSON.stringify(
		{
			version: 1,
			revision: options.revision ?? 0,
			mode: options.mode,
			status: 'complete',
			summary: {
				files: new Set(diagnostics.map((diagnostic) => diagnostic.file)).size,
				errors: diagnostics.length,
				warnings: 0
			},
			diagnostics
		},
		null,
		'\t'
	)}\n`;
	await mkdir(path.dirname(file), { recursive: true });
	if (existsSync(file) && (await readFile(file, 'utf8')) === content) return false;
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, content);
	await rename(temporary, file);
	return true;
}

export async function checkPodWorkspace(
	root: string,
	options: PodWorkspaceCheckOptions
): Promise<PodWorkspaceCheckResult> {
	const cache = path.join(root, '.svelte-check');
	await rm(cache, { recursive: true, force: true });

	// One checker process covers both plain-`.ts` type errors and `.svelte`
	// component errors over the full workspace tsconfig. `--tsgo-experimental-api`
	// runs svelte-check against the in-process native TypeScript API (~1/3 the CPU
	// and memory of a standalone tsgo pass paired with svelte-check). The escape
	// hatch falls back to the `tsgo` CLI when the experimental API misbehaves.
	const tsgoFlag =
		process.env.NORBITAL_CHECKER_MODE === 'tsgo-cli' ? '--tsgo' : '--tsgo-experimental-api';
	let svelte: CheckerProcessResult;
	try {
		svelte = await runCheckerProcess(
			process.execPath,
			[
				SVELTE_CHECK_BIN,
				'--workspace',
				root,
				'--tsconfig',
				'./tsconfig.json',
				'--output',
				'machine-verbose',
				'--threshold',
				'error',
				'--diagnostic-sources',
				'js,svelte',
				'--no-color',
				tsgoFlag
			],
			root
		);
	} finally {
		await rm(cache, { recursive: true, force: true });
	}
	const svelteDiagnostics = parseSvelteCheckOutput(svelte.stdout);
	const diagnostics = svelteDiagnostics.filter(
		(diagnostic, index, all) =>
			all.findIndex(
				(candidate) =>
					candidate.code === diagnostic.code &&
					candidate.file === diagnostic.file &&
					candidate.start.line === diagnostic.start.line &&
					candidate.start.column === diagnostic.start.column
			) === index
	);
	if (svelte.exitCode !== 0 && svelteDiagnostics.length === 0) {
		diagnostics.push(checkerFailure('SVELTE_CHECK_FAILED', 'svelte-check', svelte));
	}
	if (options.isCurrent && !options.isCurrent()) {
		return { valid: diagnostics.length === 0, published: false, changed: false, diagnostics };
	}
	const changed = await publishCheckerDiagnostics(root, diagnostics, options);
	return { valid: diagnostics.length === 0, published: true, changed, diagnostics };
}

export async function runSvelteCheck(root: string): Promise<void> {
	const result = await checkPodWorkspace(root, { mode: 'build' });
	if (!result.valid) {
		throw new Error(`Pod workspace has ${result.diagnostics.length} type-check error(s)`);
	}
}
