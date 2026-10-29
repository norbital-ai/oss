/// <reference types="node" />
// The prelude's host hooks and the guest module as a classic script: what every guest runner serves (`GuestIsolatesPort`)
// and `bolt check`'s declaration evaluation reuse. Bolt runs no guest itself: each host owns its runner as
// `HostPorts.guests` (bolt-cli's `nodeGuests`, which bolt-server and `bolt dev` use; Colony's isolated-vm).
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseSync } from 'rolldown/utils';
import type { GuestProgram } from '../engine/guest/runner.ts';

/** The prelude's `$3`: a `?bytes` import's bytes by sha256, or undefined (the guest then throws naming the sha). */
export const assetHook =
	(assets: GuestProgram['assets']) =>
	(sha: unknown): Uint8Array | undefined =>
		assets !== undefined && typeof sha === 'string' && Object.hasOwn(assets, sha)
			? assets[sha]
			: undefined;

const DIGESTS: { readonly [name: string]: string } = {
	'SHA-1': 'sha1',
	'SHA-256': 'sha256',
	'SHA-384': 'sha384',
	'SHA-512': 'sha512'
};

/** `crypto.subtle.digest`'s host half. */
export function digest(name: unknown, bytes: unknown): Uint8Array {
	// hook:check — `bolt check` installs the same prelude
	const algorithm = DIGESTS[String(name).toUpperCase()];
	if (algorithm === undefined || !(bytes instanceof Uint8Array))
		throw new Error(`digest supports ${Object.keys(DIGESTS).join(', ')}`);
	return new Uint8Array(createHash(algorithm).update(bytes).digest());
}

/** The invocation's entropy: SHA-256 blocks of its seed, so a replay with the same seed draws the same values. */
export function randomStream(seed: string): (n: unknown) => Uint8Array {
	let counter = 0;
	let pool = Buffer.alloc(0);
	return (n) => {
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65_536)
			throw new Error('random takes 0 to 65536 bytes');
		const blocks = [pool];
		for (let have = pool.length; have < n; have += 32)
			blocks.push(createHash('sha256').update(seed).update(String(counter++)).digest());
		pool = Buffer.concat(blocks);
		const out = new Uint8Array(pool.subarray(0, n));
		pool = pool.subarray(n);
		return out;
	};
}

type Statement = ReturnType<typeof parseSync>['program']['body'][number];
export type ImportDeclaration = Extract<Statement, { type: 'ImportDeclaration' }>;
type ExportName = Extract<
	Statement,
	{ type: 'ExportNamedDeclaration' }
>['specifiers'][number]['local'];
const nameOf = (name: ExportName) => (name.type === 'Literal' ? name.value : name.name);

/**
 * `guest.mjs` as a classic script whose completion value is its namespace, for a runner that evaluates scripts only.
 * An import becomes `imports`' statement, `import.meta` an empty object; exports stay live bindings. Replacements keep their spans' columns, and the wrapper is a line of its own (`lineOffset: -1`).
 */
export const moduleScript = (source: string, imports: (node: ImportDeclaration) => string) => {
	const { program, module, errors } = parseSync('guest.mjs', source);
	const error = errors[0];
	if (error !== undefined) {
		// V8's shape, which a script's failure maps back to the author's line (`run_js`): the token named, the position last
		const start = error.labels[0]?.start ?? 0;
		const before = source.slice(0, start);
		const line = before.split('\n').length;
		const column = start - before.lastIndexOf('\n');
		const token = source.slice(start, error.labels[0]?.end ?? start);
		const named = error.message === 'Unexpected token' && token !== '' ? ` '${token}'` : '';
		throw new SyntaxError(`${error.message}${named} [guest.mjs:${line}:${column}]`);
	}
	const edits: [start: number, end: number, text: string][] = [],
		exported: [name: string, local: string][] = [];
	for (const node of program.body)
		if (node.type === 'ImportDeclaration') edits.push([node.start, node.end, imports(node)]);
		else if (node.type === 'ExportAllDeclaration')
			throw new SyntaxError('guest.mjs is one module; it re-exports another');
		else if (node.type === 'ExportDefaultDeclaration') {
			const d = node.declaration;
			if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id !== null) {
				edits.push([node.start, d.start, '']);
				exported.push(['default', d.id.name]);
			} else {
				edits.push([node.start, d.start, 'var __bolt_default='], [node.end, node.end, ';']);
				exported.push(['default', '__bolt_default']);
			}
		} else if (node.type === 'ExportNamedDeclaration') {
			if (node.source !== null)
				throw new SyntaxError('guest.mjs is one module; it re-exports another');
			const d = node.declaration;
			if (d === null) {
				edits.push([node.start, node.end, '']);
				for (const s of node.specifiers) exported.push([nameOf(s.exported), nameOf(s.local)]);
				continue;
			}
			edits.push([node.start, d.start, '']);
			if (d.type === 'VariableDeclaration')
				for (const { id } of d.declarations) {
					if (id.type !== 'Identifier')
						throw new SyntaxError('guest.mjs exports a destructured binding');
					exported.push([id.name, id.name]);
				}
			else if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id !== null)
				exported.push([d.id.name, d.id.name]);
		}
	for (const meta of module.importMetas) edits.push([meta.start, meta.end, '({})']);
	let body = source;
	for (const [start, end, text] of edits.sort(([a], [b]) => b - a)) {
		const blank = source.slice(start, end).replace(/[^\n]/g, ' ');
		body = body.slice(0, start) + text + blank.slice(text.length) + body.slice(end);
	}
	const namespace = exported
		.map(([name, local]) => `get ${JSON.stringify(name)}() { return ${local}; }`)
		.join(', ');
	return `(function () { 'use strict';\n${body}\nreturn Object.freeze({ __proto__: null, ${namespace} });\n})()`;
};

/** The prelude's hooks as the host serves them (`GuestSessionOptions.prelude`). */
export type GuestHooks = readonly [
	say: (level: unknown, line: unknown) => void,
	random: (n: unknown) => Uint8Array,
	digest: (name: unknown, bytes: unknown) => Uint8Array,
	asset: (sha: unknown) => Uint8Array | undefined
];
