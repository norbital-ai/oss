// An ingest job: one file read to one answer on the disk. Each runs in a process of its own, so the server stays small and
// answers through any burst, a file that hangs or eats its memory ends alone, and all a read held goes when it exits.
// ponytail: a process per job costs about 110 ms of start; a kept worker pays off only if bursts of tiny files dominate.
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import type { Ingester, IngestRequest } from './ingest.ts';
import { fromDisk, route } from './route.ts';

export type IngestJob = Readonly<{
	name: string;
	mime: string;
	/** The file, spooled on the volume. */
	path: string;
	options?: IngestRequest['options'];
	/** Where the answer goes. */
	out: string;
}>;
export type Reads = (job: IngestJob) => Effect.Effect<void, Error>;

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const io = <A>(work: () => Promise<A>) =>
	Effect.tryPromise({ try: work, catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))) });
/** The read itself, its answer landing whole. */
export const readTo =
	(ingest: Ingester): Reads =>
	({ name, mime, path, options, out }) =>
		Effect.gen(function* () {
			const where = route(name, mime),
				bytes = where.ok && fromDisk(where.reader) ? new Uint8Array() : yield* io(() => readFile(path)),
				answer = yield* ingest({ name, mime, path, bytes, ...(options === undefined ? {} : { options }) }).pipe(
					Effect.mapError((failure) => new Error(failure.message))
				);
			yield* io(() => writeFile(`${out}.part`, JSON.stringify(answer)));
			yield* io(() => rename(`${out}.part`, out));
		});
/** A process for each read, in a group of its own so its engines end with it; past `wallMs` the group is killed. */
export const spawned =
	(wallMs: number): Reads =>
	(job) =>
		Effect.callback<void, Error>((resume, signal) => {
			const child = spawn(process.execPath, [WORKER, JSON.stringify(job)], {
				detached: true,
				stdio: ['ignore', 'ignore', 'pipe']
			});
			let said = '',
				late = false;
			const kill = () => {
				if (child.pid !== undefined) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						// already gone
					}
				}
			};
			const wall = setTimeout(() => {
				late = true;
				kill();
			}, wallMs);
			signal.addEventListener('abort', kill);
			child.stderr.on('data', (chunk: Buffer) => {
				said = (said + chunk.toString('utf8')).slice(-2000);
			});
			child.once('error', (error) => resume(Effect.fail(error)));
			child.once('close', (code, killed) => {
				clearTimeout(wall);
				signal.removeEventListener('abort', kill);
				if (code === 0) return resume(Effect.void);
				resume(
					Effect.fail(
						new Error(
							late
								? `The read took longer than ${Math.round(wallMs / 1000)} s.`
								: killed === 'SIGKILL'
									? 'The read ran out of memory.'
									: said.trim() || `The read ended with ${code ?? killed}.`
						)
					)
				);
			});
		});
