/// <reference types="node" />
// A `.svelte` component as the checker sees it (compute model §5, "The language tool"), built as svelte-check's
// TypeScript 7 mode builds it: svelte2tsx's TypeScript is a virtual `X_virtual__.ts` beside `X.svelte` (checked as
// source), and `X.d.svelte.ts` re-exports it, which is what `import './X.svelte'` resolves to under
// `allowArbitraryExtensions`. Positions map both ways through svelte2tsx's source map; generated code maps to nothing.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { eachMapping, TraceMap } from '@jridgewell/trace-mapping';
import { Option, Schema } from 'effect';
import { svelte2tsx } from 'svelte2tsx';

const SUFFIX = '_virtual__';
const S2T = dirname(createRequire(import.meta.url).resolve('svelte2tsx/package.json'));

/** The checked shadow of `X.svelte`: `X_virtual__.ts`, or `.js` for a component whose script is not TypeScript. */
export const shadowOf = (path: string, ts: boolean) =>
	`${path.slice(0, -'.svelte'.length)}${SUFFIX}${ts ? '.ts' : '.js'}`;
/** `X.d.svelte.ts`: the module `import './X.svelte'` resolves to. */
export const redirectOf = (path: string) => `${path.slice(0, -'.svelte'.length)}.d.svelte.ts`;
/** The component a shadow (or its redirect) stands for; `undefined` for any other path. */
export const componentOf = (path: string) => {
	const m = /^(.*)_virtual__\.[jt]s$/.exec(path) ?? /^(.*)\.d\.svelte\.ts$/.exec(path);
	return m === null ? undefined : `${m[1]}.svelte`;
};
export const redirectText = (path: string, ts: boolean) => {
	const target = `./${shadowOf(path, ts)
		.split('/')
		.pop()
		?.replace(/\.[jt]s$/, '.js')}`;
	return `export { default } from ${JSON.stringify(target)};\nexport * from ${JSON.stringify(target)};\n`;
};
/** svelte2tsx's global declarations, by file name; `svelte-jsx-v4.d.ts` only where Svelte ships no `svelte-html.d.ts`. */
const SHIMS = new Map(
	[false, true].map((svelteHtml): [boolean, ReadonlyMap<string, string>] => [
		svelteHtml,
		new Map(
			[
				'svelte-shims-v4.d.ts',
				'svelte-native-jsx.d.ts',
				...(svelteHtml ? [] : ['svelte-jsx-v4.d.ts'])
			].map((name) => [name, readFileSync(join(S2T, name), 'utf8')])
		)
	])
);
export const shims = (svelteHtml: boolean): ReadonlyMap<string, string> =>
	SHIMS.get(svelteHtml) ?? new Map();

const isTs = (text: string) => /<script\b[^>]*\blang\s*=\s*["']?(ts|typescript)\b/.test(text);
const starts = (text: string) => {
	const at = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) at.push(i + 1);
	return at;
};
/** The index of the greatest `pairs[i][0]` ≤ `offset`, or -1. */
const floor = (pairs: readonly (readonly [number, number])[], offset: number) => {
	let lo = 0,
		hi = pairs.length - 1,
		at = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if ((pairs[mid]?.[0] ?? 0) <= offset) {
			at = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return at;
};
/**
 * Maps `offset` from one side of the segments to the other: its place inside the nearest segment starting at or
 * before it, kept only while both sides still belong to that segment (the next start on either side ends it).
 */
const across = (
	from: readonly (readonly [number, number])[],
	to: readonly (readonly [number, number])[],
	lengths: readonly [number, number],
	offset: number
): number | undefined => {
	const i = floor(from, offset);
	const segment = from[i];
	if (segment === undefined) return undefined;
	const delta = offset - segment[0],
		j = floor(to, segment[1]);
	const fromEnd = from[i + 1]?.[0] ?? lengths[0],
		toEnd = to.slice(j + 1).find(([start]) => start > segment[1])?.[0] ?? lengths[1];
	return delta < fromEnd - segment[0] && delta <= toEnd - segment[1]
		? segment[1] + delta
		: undefined;
};

const CompileError = Schema.Struct({
	message: Schema.String,
	position: Schema.optionalKey(Schema.Tuple([Schema.Number, Schema.Number]))
});

export type Shadow = {
	readonly path: string;
	readonly code: string;
	readonly ts: boolean;
	/** The parse error svelte2tsx refused the component with: `code` is then an empty module. */
	readonly error?: { readonly message: string; readonly offset: number };
	/** A shadow offset → the component's, `undefined` inside generated code; and back. */
	readonly toOriginal: (offset: number) => number | undefined;
	readonly toGenerated: (offset: number) => number | undefined;
};

/** `X.svelte`'s shadow. `path` is the component's absolute path. */
export function shadow(path: string, text: string): Shadow {
	const ts = isTs(text),
		at = shadowOf(path, ts);
	let out: ReturnType<typeof svelte2tsx>;
	try {
		out = svelte2tsx(text, {
			filename: path,
			isTsFile: ts,
			mode: 'ts',
			typingsNamespace: 'svelteHTML',
			emitOnTemplateError: false,
			...(ts ? {} : { emitJsDoc: true })
		});
	} catch (cause) {
		const decoded = Schema.decodeUnknownOption(CompileError)(cause);
		const message = Option.match(decoded, {
			onNone: () => String(cause),
			onSome: (e) => e.message
		});
		const offset = Option.match(decoded, { onNone: () => 0, onSome: (e) => e.position?.[0] ?? 0 });
		return {
			path: at,
			code: 'export {};\n',
			ts,
			error: { message, offset },
			toOriginal: () => undefined,
			toGenerated: () => undefined
		};
	}
	const generated = starts(out.code),
		original = starts(text);
	const pairs: [number, number][] = [];
	// svelte2tsx emits a MagicString v3 map but types `version` as `number`
	eachMapping(new TraceMap({ ...out.map, version: 3 }), (m) => {
		if (m.originalLine === null) return;
		pairs.push([
			(generated[m.generatedLine - 1] ?? 0) + m.generatedColumn,
			(original[m.originalLine - 1] ?? 0) + m.originalColumn
		]);
	});
	const byGenerated = pairs.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
	// the first generated place of an original offset wins (svelte2tsx repeats props and their defaults)
	const byOriginal = pairs
		.map(([g, o]) => [o, g] as const)
		.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
	return {
		path: at,
		code: out.code,
		ts,
		toOriginal: (offset) => across(byGenerated, byOriginal, [out.code.length, text.length], offset),
		toGenerated: (offset) => across(byOriginal, byGenerated, [text.length, out.code.length], offset)
	};
}
