/// <reference types="node" />
// A release directory as the engine reads it (`ArtifactPort`): posix paths relative to the release, and `../seed/<pack>/…`
// for the build's seed packs beside it. Symlinks are resolved here, and a path that resolves outside its root (the
// release, or its pack) is refused, so the engine's own path checks need no `realPath`.
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Effect, Option } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { ArtifactPort, ArtifactStat } from '../engine/contracts.ts';
import { Port } from '../engine/port.ts';

const refused = (path: string) =>
	new FacilityFailure({ kind: 'invalid', message: `the artifact has no path '${path}'` });
const absent = (error: unknown) => {
	const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;
	return code === 'ENOENT' || code === 'ENOTDIR';
};
/** The real location, or none for nothing there. */
const real = (at: string) =>
	Port.attempt('artifact', () =>
		realpath(at).then(
			(resolved): string | null => resolved,
			(error: unknown) => (absent(error) ? null : Promise.reject(error))
		)
	).pipe(Effect.map(Option.fromNullOr));

export function artifactPort(release: string): ArtifactPort {
	const locate = (path: string) =>
		Effect.gen(function* () {
			const segments = path === '' ? [] : path.split('/'),
				seeded = segments[0] === '..';
			if (
				segments.some(
					(s, i) =>
						s === '' || s === '.' || s.includes('\\') || s.includes('\0') || (s === '..' && i > 0)
				) ||
				(seeded && (segments[1] !== 'seed' || segments.length < 3))
			)
				return yield* Effect.fail(refused(path));
			const root = seeded ? join(release, '..', 'seed', segments[2] ?? '') : release;
			const base = yield* real(root),
				at = yield* real(join(root, ...segments.slice(seeded ? 3 : 0)));
			if (Option.isNone(base) || Option.isNone(at)) return Option.none<string>();
			if (at.value !== base.value && !at.value.startsWith(base.value + sep))
				return yield* Effect.fail(refused(path));
			return at;
		});
	const kind = (at: string) =>
		Port.attempt('artifact', () => stat(at)).pipe(
			Effect.map((s): ArtifactStat | null =>
				s.isFile()
					? { kind: 'file', size: s.size }
					: s.isDirectory()
						? { kind: 'directory', size: s.size }
						: null
			)
		);
	const read = (path: string) =>
		Effect.gen(function* () {
			const at = yield* locate(path);
			if (Option.isNone(at)) return yield* Effect.fail(refused(path));
			const bytes = yield* Port.attempt('artifact', () => readFile(at.value));
			return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		});
	const list = (dir: string) =>
		Effect.gen(function* () {
			const at = yield* locate(dir);
			if (Option.isNone(at)) return [];
			const names = yield* Port.attempt('artifact', () => readdir(at.value, { recursive: true }));
			const files: string[] = [];
			for (const name of names)
				if ((yield* kind(join(at.value, name)))?.kind === 'file')
					files.push(name.split(sep).join('/'));
			return files.sort();
		});
	const status = (path: string) =>
		Effect.flatMap(locate(path), (at) =>
			Option.isNone(at) ? Effect.succeed(null) : kind(at.value)
		);
	return {
		read: (path, signal) => Effect.runPromise(read(path), { signal }),
		list: (dir, signal) => Effect.runPromise(list(dir), { signal }),
		stat: (path, signal) => Effect.runPromise(status(path), { signal })
	};
}
