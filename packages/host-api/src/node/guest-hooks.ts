/// <reference types="node" />
// The prelude's host hooks and the guest module as a classic script: what every guest runner serves (`GuestIsolatesPort`)
// and `bolt check`'s declaration evaluation reuse. Bolt runs no guest itself: each host owns its runner as
// `HostPorts.guests` (`@norbital-ai/host-api/node`'s `node_guests`, which bolt-server and `bolt dev` use; Colony's isolated-vm).
import { Buffer } from 'node:buffer';
import { createCipheriv, createHash } from 'node:crypto';
import { parseSync } from 'rolldown/utils';
import type { GuestProgram } from '../index.ts';

/** The prelude's `$3`: a `?bytes` import's bytes by sha256, or undefined (the guest then throws naming the sha). */
export const asset_hook =
	(assets: GuestProgram['assets']) =>
	(sha: unknown): Uint8Array | undefined =>
		assets !== undefined && typeof sha === 'string' && Object.hasOwn(assets, sha)
			? assets[sha]
			: undefined;

/** What one guest turn keeps of its console: lines, characters per line and in all; past them, lines are counted. */
export const GUEST_CONSOLE = { lines: 200, lineChars: 8000, chars: 256 * 1024 } as const;
/** A session's console lines since its last turn; the runner resets `chars` and `dropped` with each turn it reads. */
export type GuestSaid = { readonly lines: [level: string, line: string][]; chars: number; dropped: number };
/**
 * The prelude's `$0`, host side. The guest's own clip is guest code it can replace, so the bound is here: only strings
 * are kept (never a guest object's `toString`), each clipped to its share before the host keeps it.
 */
export const console_hook =
	(said: GuestSaid) =>
	(level: unknown, line: unknown): void => {
		if (
			typeof level !== 'string' ||
			typeof line !== 'string' ||
			said.lines.length >= GUEST_CONSOLE.lines ||
			said.chars >= GUEST_CONSOLE.chars
		) {
			said.dropped++;
			return;
		}
		const kept = line.slice(0, Math.min(GUEST_CONSOLE.lineChars, GUEST_CONSOLE.chars - said.chars));
		said.lines.push([level.slice(0, 16), kept]);
		said.chars += kept.length;
	};

/** Host-side caps on synchronous guest crypto hooks so an isolate cannot stall the host event loop. */
export const GUEST_CRYPTO = {
	maxDigestBytes: 4 * 1024 * 1024,
	maxSessionDigestBytes: 16 * 1024 * 1024,
	maxSessionRandomBytes: 1024 * 1024
} as const;

const DIGESTS: { readonly [name: string]: string } = {
	'SHA-1': 'sha1',
	'SHA-256': 'sha256',
	'SHA-384': 'sha384',
	'SHA-512': 'sha512'
};

/** `crypto.subtle.digest`'s host half, capped per call so a guest cannot stall the host event loop. */
export function digest(name: unknown, bytes: unknown): Uint8Array {
	const algorithm = DIGESTS[String(name).toUpperCase()];
	if (algorithm === undefined || !(bytes instanceof Uint8Array))
		throw new Error(`digest supports ${Object.keys(DIGESTS).join(', ')}`);
	if (bytes.byteLength > GUEST_CRYPTO.maxDigestBytes)
		throw new Error(`digest takes at most ${GUEST_CRYPTO.maxDigestBytes} bytes per call`);
	return new Uint8Array(createHash(algorithm).update(bytes).digest());
}

/** Stateful `crypto.subtle.digest` hook with a per-invocation cumulative byte ceiling. */
export function digest_hook(maxBytes: number = GUEST_CRYPTO.maxSessionDigestBytes): (name: unknown, bytes: unknown) => Uint8Array {
	let used = 0;
	return (name, bytes) => {
		const algorithm = DIGESTS[String(name).toUpperCase()];
		if (algorithm === undefined || !(bytes instanceof Uint8Array))
			throw new Error(`digest supports ${Object.keys(DIGESTS).join(', ')}`);
		if (bytes.byteLength > GUEST_CRYPTO.maxDigestBytes)
			throw new Error(`digest takes at most ${GUEST_CRYPTO.maxDigestBytes} bytes per call`);
		used += bytes.byteLength;
		if (used > maxBytes)
			throw new Error(`digest exceeded the invocation limit of ${maxBytes} bytes`);
		return new Uint8Array(createHash(algorithm).update(bytes).digest());
	};
}

/** The invocation's deterministic entropy stream (AES-256-CTR keyed by `sha256(seed)`), capped per invocation. */
export function random_stream(
	seed: string,
	maxBytes: number = GUEST_CRYPTO.maxSessionRandomBytes
): (n: unknown) => Uint8Array {
	const key = createHash('sha256').update(seed).digest();
	const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16));
	let used = 0;
	return (n) => {
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65_536)
			throw new Error('random takes 0 to 65536 bytes');
		used += n;
		if (used > maxBytes)
			throw new Error(`random exceeded the invocation limit of ${maxBytes} bytes`);
		if (n === 0) return new Uint8Array(0);
		return new Uint8Array(cipher.update(Buffer.alloc(n)));
	};
}

type Statement = ReturnType<typeof parseSync>['program']['body'][number];
/** An `import` statement of the parsed guest module, as `module_script` hands it to its `imports` rewriter. */
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
export const module_script = (source: string, imports: (node: ImportDeclaration) => string) => {
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
