// One conversion: pandoc reads Markdown or HTML and writes the target; a PDF is typeset by Typst. `--sandbox` confines
// pandoc to the files on its command line (no local reads, no fetched resources), `+RTS -M` caps its heap, and the
// process is killed at the timeout.
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Schema } from 'effect';

export const TARGETS = {
	pdf: 'application/pdf',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	epub: 'application/epub+zip',
	html: 'text/html; charset=utf-8'
} as const;
export type Target = keyof typeof TARGETS;
export const PAPER = { A4: 'a4', A3: 'a3', Letter: 'us-letter' } as const;
/** Targets a reference document styles (pandoc's `--reference-doc`). */
export const STYLED: readonly Target[] = ['docx', 'pptx', 'odt'];

/** CJK font fallback, table-cell escaping and data-URI image names (see the filter). */
const FILTER = fileURLToPath(new URL('./convert.lua', import.meta.url));
/** pandoc's reference.docx with an A4 portrait section and the PDF's margins; the Dockerfile writes it. */
const A4 = fileURLToPath(new URL('./a4.docx', import.meta.url));

export type Request = {
	from: 'markdown' | 'html';
	to: Target;
	source: string;
	page?: keyof typeof PAPER;
	landscape?: boolean;
};
export class ConversionFailed extends Schema.TaggedError<ConversionFailed>()('ConversionFailed', {
	message: Schema.String
}) {}
export const processFailure = (
	code: number | null,
	signal: NodeJS.Signals | null,
	killed: boolean,
	stderr: string,
	timeout: number
) =>
	new ConversionFailed({
		// Node's deadline calls child.kill(); an external kill does not set child.killed.
		message:
			signal === 'SIGKILL' && killed
				? `The conversion took longer than ${timeout / 1000} s.`
				: stderr.trim() || `pandoc exited with ${code ?? signal}`
	});
const failed = (cause: unknown) =>
	new ConversionFailed({
		message: cause instanceof Error ? cause.message : String(cause)
	});
export type Converter = (
	request: Request,
	reference: Uint8Array | null
) => Effect.Effect<Uint8Array, ConversionFailed>;

export const pandoc = ({ timeoutMs, heap }: { timeoutMs: number; heap: string }): Converter =>
	Effect.fn('Convert.pandoc')(function* (request: Request, reference: Uint8Array | null) {
		return yield* Effect.acquireUseRelease(
			Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), 'convert-')), catch: failed }),
			(dir) =>
				Effect.gen(function* () {
					const out = join(dir, `out.${request.to}`);
					const args = [
						'+RTS',
						`-M${heap}`,
						'-RTS',
						'--sandbox',
						'--standalone',
						'-f',
						request.from,
						'-o',
						out,
						`--lua-filter=${FILTER}`
					];
					if (request.to === 'pdf') {
						args.push('--pdf-engine=typst', '-V', `papersize=${PAPER[request.page ?? 'A4']}`);
						if (request.landscape) args.push('-M', 'landscape=true');
					} else args.push('-t', request.to);
					if (reference) {
						const ref = join(dir, `reference.${request.to}`);
						yield* Effect.tryPromise({
							try: (signal) => writeFile(ref, reference, { signal }),
							catch: failed
						});
						args.push(`--reference-doc=${ref}`);
					} else if (
						request.to === 'docx' &&
						(yield* Effect.tryPromise({ try: () => access(A4), catch: failed }).pipe(
							Effect.match({ onFailure: () => false, onSuccess: () => true })
						))
					)
						args.push(`--reference-doc=${A4}`);
					yield* run(args, request.source, dir, timeoutMs);
					return new Uint8Array(
						yield* Effect.tryPromise({ try: (signal) => readFile(out, { signal }), catch: failed })
					);
				}),
			(dir) =>
				Effect.tryPromise({ try: () => rm(dir, { recursive: true, force: true }), catch: failed })
		);
	});

const run = Effect.fn('Convert.process')(function* (
	args: string[],
	input: string,
	cwd: string,
	timeout: number
) {
	let closed = false;
	let spawnError: Error | undefined;
	let stderr = '';
	const data = (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2000);
	};
	const recordError = (cause: Error) => {
		spawnError = cause;
	};
	const recordClose = () => {
		closed = true;
	};
	// A rejected pipe reports the process's own diagnostic on close.
	const pipeError = () => {};
	return yield* Effect.acquireUseRelease(
		Effect.try({
			try: () => {
				const child = spawn('pandoc', args, {
					cwd,
					timeout,
					killSignal: 'SIGKILL',
					stdio: ['pipe', 'ignore', 'pipe']
				});
				child.once('close', recordClose);
				child.on('error', recordError);
				child.stderr.on('data', data);
				child.stdin.on('error', pipeError);
				return child;
			},
			catch: failed
		}),
		(child) =>
			Effect.callback<void, ConversionFailed>((resume) => {
				const error = (cause: Error) => resume(Effect.fail(failed(cause)));
				const close = (code: number | null, signal: NodeJS.Signals | null) =>
					resume(
						code === 0
							? Effect.void
							: Effect.fail(processFailure(code, signal, child.killed, stderr, timeout))
					);
				if (spawnError !== undefined) return error(spawnError);
				if (closed) return close(child.exitCode, child.signalCode);
				child.once('error', error);
				child.once('close', close);
				child.stdin.end(input);
				return Effect.sync(() => {
					child.off('error', error);
					child.off('close', close);
				});
			}),
		(child) =>
			Effect.callback<void>((resume) => {
				if (closed) return resume(Effect.void);
				child.once('close', () => resume(Effect.void));
				child.kill('SIGKILL');
			}).pipe(
				Effect.andThen(
					Effect.sync(() => {
						child.stderr.off('data', data);
						child.off('error', recordError);
						child.off('close', recordClose);
						child.stdin.off('error', pipeError);
					})
				)
			)
	);
});
