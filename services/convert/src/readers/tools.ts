// The engines are programs of their own: each starts for one file, and all it held ends with it.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';

/** What one engine may answer: past this a file's answer could not be one string anyway. */
const ANSWER_BYTES = 1024 * 1024 * 1024;
export const tool = (binary: string, args: readonly string[]) =>
	Effect.callback<Buffer, Error>((resume, signal) => {
		execFile(binary, args, { encoding: 'buffer', maxBuffer: ANSWER_BYTES, signal }, (error, stdout) =>
			resume(error === null ? Effect.succeed(stdout) : Effect.fail(error))
		);
	});
const io = <A>(work: () => Promise<A>) =>
	Effect.tryPromise({ try: work, catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))) });
/** A directory for one read, gone with the scope. */
export const scratch = Effect.acquireRelease(
	io(() => mkdtemp(join(tmpdir(), 'convert-'))),
	(dir) => Effect.ignore(io(() => rm(dir, { recursive: true, force: true })))
);
/** The file under `name` in a directory of its own: a link to it on the disk, or its bytes written there. */
export const named = (file: { readonly bytes: Uint8Array; readonly path?: string }, name: string) =>
	Effect.gen(function* () {
		const dir = yield* scratch,
			path = join(dir, name);
		yield* io(() => (file.path === undefined ? writeFile(path, file.bytes) : symlink(file.path, path)));
		return path;
	});
