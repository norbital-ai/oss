/// <reference types="node" />
// `guest.snapshot` (`bolt build`): a V8 startup snapshot of the prelude and the evaluated `guest.mjs`, so an invocation
// restores a fresh isolate instead of compiling and evaluating the bundle. V8 aborts the process on a heap it cannot
// serialize (a native-backed object made at module top level, e.g. an `Intl` formatter), so it is made in a child
// process; a refusal leaves the artifact without one and the runner evaluates per invocation as before.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { SNAPSHOT_PRELUDE } from '../../engine/guest/prelude.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';

// the child: scripts as JSON on stdin, the snapshot bytes on stdout
const CHILD = `const ivm = require(process.argv[1]), chunks = [];
process.stdin.on('data', (c) => chunks.push(c)).on('end', () => {
	const s = ivm.Isolate.createSnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')));
	process.stdout.write(Buffer.from(s.copy()));
});`;
const EXPORT = /^export \{ ([\w$]+) as default \};$/m;

/**
 * `guest.mjs` as a script with the same line and column positions (its source map still applies): the module body in a
 * strict function, its default export as `__boltGuest.default`, where the runner's `start` reads the namespace, and
 * `import.meta` (empty in the isolate; vite's preload helper names it) as an empty object of the same length's name.
 */
export function guestScript(source: string): string | undefined {
	const exported = EXPORT.exec(source);
	if (exported === null) return undefined; // any other export or import is a syntax error in a script: refused below
	const body = source.replace(EXPORT, () => `globalThis.__boltGuest = { default: ${exported[1]} };`).replace(/\bimport\.meta\b/g, '$importMeta');
	return `(function () { 'use strict'; const $importMeta = {};\n${body}\n})();`;
}

export function buildSnapshot(program: GuestProgram): { bytes: Uint8Array } | { refused: string } {
	const code = guestScript(program.source);
	if (code === undefined) return { refused: 'guest.mjs has no default export line' };
	const scripts = [{ code: SNAPSHOT_PRELUDE, filename: 'bolt:prelude' }, { code, filename: 'guest.mjs', lineOffset: -1 }];
	// fixed seeds and one thread make the bytes (and so the artifact hash) reproducible: background compilation would make
	// what the heap holds depend on the machine's load; a restored isolate rehashes and reseeds on this host's
	const child = spawnSync(process.execPath, ['--hash-seed=1', '--random-seed=1', '--single-threaded', '-e', CHILD, createRequire(import.meta.url).resolve('isolated-vm')],
		{ input: JSON.stringify(scripts), maxBuffer: 512 * 2 ** 20, timeout: 120_000 });
	if (child.status === 0 && child.stdout.byteLength > 0) return { bytes: new Uint8Array(child.stdout) };
	const err = child.stderr?.toString('utf8') ?? '';
	const error = /^\w*Error: .*/m.exec(err)?.[0];
	if (error !== undefined) return { refused: error };
	const fatal = /^# (?!Fatal error)(\S.*)/m.exec(err)?.[1];
	return { refused: fatal === undefined ? child.error?.message ?? `the snapshot child exited ${child.status ?? child.signal}`
		: `V8 aborted (${fatal}): an object made at module top level is native-backed (an Intl formatter, a WeakRef, …); make it at first use` };
}
