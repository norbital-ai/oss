/**
 * Locate and run the graph analyzer that lives beside this package's build output.
 *
 * The engine is shipped as `.mjs` rather than compiled from `src`, and deliberately so: its output
 * is a release gate, and the phase that turns it into typed modules has to prove byte-identical
 * findings before anything depends on the new shape. Compiling it now would mean changing the
 * detector and the packaging in one step, with no way to attribute a changed finding to either.
 *
 * `engine/` and `build/` are siblings in the workspace and in the published tarball alike, so one
 * relative URL resolves in both.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path to one of the engine entrypoints. */
export function enginePath(script: 'analyze'): string {
	const path = fileURLToPath(new URL(`../engine/scripts/${script}.mjs`, import.meta.url));
	if (!existsSync(path))
		throw new Error(
			`@norbital-ai/doctor is missing its engine at ${path}. A published install ships "engine" in "files"; a workspace checkout needs no build step for it.`
		);
	return path;
}

export type EngineRun = Readonly<{
	/** 0 clean, 1 valid evidence with actionable debt, 2 evidence incomplete or invalid. */
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}>;

/**
 * Run an engine entrypoint to completion.
 *
 * Exit 1 is a result, not a failure: it means the analysis is valid and found actionable debt.
 * Only a spawn error rejects, so callers branch on `status` rather than on a thrown value.
 */
export function runEngine(
	script: 'analyze',
	argv: ReadonlyArray<string>,
	options: Readonly<{
		cwd?: string | undefined;
		env?: NodeJS.ProcessEnv | undefined;
		signal?: AbortSignal | undefined;
	}> = {}
): Promise<EngineRun> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[enginePath(script), ...argv],
			{
				cwd: options.cwd,
				env: options.env ?? process.env,
				signal: options.signal,
				maxBuffer: 64 * 1024 * 1024,
				encoding: 'utf8'
			},
			(error, stdout, stderr) => {
				const status = (error as (Error & { code?: number }) | null)?.code;
				if (error && typeof status !== 'number') {
					reject(error);
					return;
				}
				resolve({ status: status ?? 0, stdout, stderr });
			}
		);
	});
}
