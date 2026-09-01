import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type NodeTestProbeResult = Readonly<{
	readonly pass: number;
	readonly fail: number;
	readonly cases: ReadonlyArray<string>;
	readonly output: string;
}>;

const counter = (output: string, label: string): number =>
	Number(new RegExp(`^# ${label} (\\d+)$`, 'mu').exec(output)?.[1] ?? Number.NaN);

const caseNames = (output: string): ReadonlyArray<string> =>
	[...output.matchAll(/^(not )?ok \d+ - (?<name>.*)$/gmu)].map(
		(match) => `${match[1] === undefined ? 'ok' : 'not ok'} ${match.groups?.name ?? ''}`
	);

/**
 * Executes one `node:test` file in a child process and reports its own summary.
 *
 * The RFC receipt probes are `node --test` sources, not Vitest sources, and their value is that
 * their reviewed bytes are the thing that ran. Rewriting them into Vitest to get them collected
 * would retire the byte pin that makes the receipt a receipt, so the owned suite runs them the way
 * the receipt ran them and asserts on the child's exit code and its declared pass/fail counts.
 */
export const runNodeTestProbe = async (url: URL, timeout: number): Promise<NodeTestProbeResult> => {
	const file = fileURLToPath(url);
	const result = await run(process.execPath, ['--test', '--test-reporter=tap', file], {
		timeout,
		maxBuffer: 32 * 1024 * 1024
	}).catch((failure: unknown) => {
		const stdout = String((failure as { stdout?: unknown }).stdout ?? '');
		const stderr = String((failure as { stderr?: unknown }).stderr ?? '');
		throw new Error(`node --test failed for ${file}\n${stdout}\n${stderr}`);
	});
	const output = `${result.stdout}${result.stderr}`;
	const cases = caseNames(output);
	// The probe sources are not Vitest files, so their case names never reach the reporter on their
	// own. Echoing the child's TAP lines is how a reader of the suite output sees which of the
	// twenty-one receipt probes actually ran.
	console.info(`${file}\n${cases.map((name) => `  ${name}`).join('\n')}`);
	return { pass: counter(output, 'pass'), fail: counter(output, 'fail'), cases, output };
};
