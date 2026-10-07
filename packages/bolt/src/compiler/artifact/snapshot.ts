/// <reference types="node" />
// `guest.snapshot` (`bolt build`): a V8 startup snapshot of the prelude and the evaluated `guest.mjs`, so an invocation
// restores a fresh isolate instead of compiling and evaluating the bundle. The bytes are made in a child with fixed
// seeds (reproducible), but a heap V8 will snapshot is not always a heap the host's differently-seeded deserializer can
// restore — an external string's rehash can abort the whole process, uncatchably. So the bytes are restored once more,
// host-seeded, in a second child: a snapshot that does not survive that is refused and the artifact ships without one,
// as before. V8 also aborts the creating child on a heap it cannot serialize (a native-backed object made at module top
// level, e.g. an `Intl` formatter), which is refused the same way.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_PRELUDE } from '../../engine/guest/prelude.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';

// the child: scripts as JSON on stdin, the snapshot bytes on stdout
const CHILD = `const ivm = require(process.argv[1]), chunks = [];
process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {
	const s = ivm.Isolate.createSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
	process.stdout.write(Buffer.from(s.copy()));
});`;
// the restore child: the snapshot file in argv, several isolates alive at once as the runner's warm pool and in-flight
// invocations have them, nothing on stdout but `ok`; host flags, exactly as the runner restores
const RESTORE = `const ivm = require(process.argv[1]), fs = require('node:fs');
(async () => {
	const b = fs.readFileSync(process.argv[2]);
	const copy = new ivm.ExternalCopy(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
	const isolates = [0, 1, 2].map(() => new ivm.Isolate({ snapshot: copy }));
	await Promise.all(isolates.map(async (isolate) => {
		const context = await isolate.createContext();
		if ((await context.eval('1 + 1')) !== 2) throw new Error('the restored snapshot does not run');
	}));
	for (const isolate of isolates) isolate.dispose();
	process.stdout.write('ok');
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(1); });`;
// Rolldown may place the default export inline; only trailing comments may follow it.
const EXPORT =
	/\bexport\s*\{\s*([\w$]+)\s+as\s+default\s*\}\s*;(?=\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*$)/;

/**
 * `guest.mjs` as a script with the same line and column positions (its source map still applies): the module body in a
 * strict function, its default export as `__boltGuest.default`, where the runner's `start` reads the namespace, and
 * `import.meta` (empty in the isolate; vite's preload helper names it) as an empty object of the same length's name.
 */
export function guestScript(source: string): string | undefined {
	const exported = EXPORT.exec(source);
	if (exported === null) return undefined; // any other export or import is a syntax error in a script: refused below
	const body = source
		.replace(EXPORT, () => `globalThis.__boltGuest = { default: ${exported[1]} };`)
		.replace(/\bimport\.meta\b/g, '$importMeta');
	return `(function () { 'use strict'; const $importMeta = {};\n${body}\n})();`;
}

/** Restore the bytes once, host-seeded, in a child: uncaught V8 aborts are the point of the check. */
function restores(bytes: Uint8Array, ivm: string): string | undefined {
	const dir = mkdtempSync(join(tmpdir(), 'bolt-snapshot-'));
	try {
		const file = join(dir, 'guest.snapshot');
		writeFileSync(file, bytes);
		const child = spawnSync(process.execPath, ['-e', RESTORE, ivm, file], {
			maxBuffer: 16 * 2 ** 20,
			timeout: 120_000
		});
		if (child.status === 0 && child.stdout.toString('utf8') === 'ok') return undefined;
		const err = child.stderr?.toString('utf8') ?? '';
		const error = /^\w*Error: .*/m.exec(err)?.[0] ?? /^# Check failed: (\S.*)/m.exec(err)?.[1];
		return (
			error ?? child.error?.message ?? `the restore child exited ${child.status ?? child.signal}`
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function buildSnapshot(program: GuestProgram): { bytes: Uint8Array } | { refused: string } {
	const code = guestScript(program.source);
	if (code === undefined) return { refused: 'guest.mjs has no default export line' };
	const scripts = [
		{ code: SNAPSHOT_PRELUDE, filename: 'bolt:prelude' },
		{ code, filename: 'guest.mjs', lineOffset: -1 }
	];
	const ivm = createRequire(import.meta.url).resolve('isolated-vm');
	// fixed seeds and one thread make the bytes (and so the artifact hash) reproducible: background compilation would make
	// what the heap holds depend on the machine's load; a restored isolate rehashes and reseeds on this host's
	const child = spawnSync(
		process.execPath,
		['--hash-seed=1', '--random-seed=1', '--single-threaded', '-e', CHILD, ivm],
		{ input: JSON.stringify(scripts), maxBuffer: 512 * 2 ** 20, timeout: 120_000 }
	);
	if (child.status === 0 && child.stdout.byteLength > 0) {
		const bytes = new Uint8Array(child.stdout);
		const refused = restores(bytes, ivm);
		return refused === undefined
			? { bytes }
			: { refused: `the snapshot does not restore on this host: ${refused}` };
	}
	const err = child.stderr?.toString('utf8') ?? '';
	const error = /^\w*Error: .*/m.exec(err)?.[0];
	if (error !== undefined) return { refused: error };
	const fatal = /^# (?!Fatal error)(\S.*)/m.exec(err)?.[1];
	return {
		refused:
			fatal === undefined
				? (child.error?.message ?? `the snapshot child exited ${child.status ?? child.signal}`)
				: `V8 aborted (${fatal}): an object made at module top level is native-backed (an Intl formatter, a WeakRef, …); make it at first use`
	};
}
