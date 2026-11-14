// The source checks: foot-guns whose types pass and whose runtime is wrong, read from each `src/**` module's syntax
// (a component's `<script>` blocks included) with the parser the bundle stage uses. A `try` around a `yield*`, a
// read in a write callback's loop, `set ?? before`, a retried run's unkeyed `act`, two acts one after another (separate
// commits), a `ctx.wait` outside a job, and an import past the author contract.
import { parseSync, Visitor, type ESTree } from 'vite';
import type { EngineManifest } from '@norbital-ai/bolt/engine';
import type { Discovered } from '../discover.ts';
import type { Finding } from './rules.ts';

/** The `@norbital-ai/bolt` entry points a workspace may import. */
const AUTHOR = new Set(['@norbital-ai/bolt', '@norbital-ai/bolt/errors', '@norbital-ai/bolt/page']);
const ITERATORS = new Set(['map', 'flatMap', 'forEach', 'filter', 'reduce', 'some', 'every']);
/** Files whose bodies read under the per-call cap: models (write callbacks, effects, syncs) and policies (verdicts). */
const CAPPED = /(^|\/)\+model\.ts$|\.policy\.ts$|(^|\/)\+?[^/]*sync\.ts$/;
const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

type Span = { readonly start: number; readonly end: number };
const within = (outer: Span, at: number) => outer.start <= at && at < outer.end;
/** The innermost span holding `at`. */
const innermost = (spans: readonly Span[], at: number) =>
	spans.reduce<Span | undefined>(
		(best, s) => (within(s, at) && (best === undefined || s.end - s.start < best.end - best.start) ? s : best),
		undefined
	);
/** A statement that never falls through to the next one: it returns, throws, breaks or continues last. */
const exits = (s: ESTree.Statement): boolean =>
	s.type === 'ReturnStatement' ||
	s.type === 'ThrowStatement' ||
	s.type === 'BreakStatement' ||
	s.type === 'ContinueStatement' ||
	(s.type === 'BlockStatement' && s.body.slice(-1).some(exits));
/** A plain member expression's object and property name (`a.b?.c` → `a.b`, `c`). */
const member = (e: ESTree.Expression) => {
	const inner = e.type === 'ChainExpression' ? e.expression : e;
	return inner.type === 'MemberExpression' && !inner.computed && inner.property.type === 'Identifier'
		? { object: inner.object, name: inner.property.name }
		: undefined;
};

/** One module's code and where it starts in its file (a component's script block sits inside markup). */
type Script = { readonly code: string; readonly offset: number };
const scripts = (path: string, text: string): readonly Script[] =>
	path.endsWith('.svelte')
		? [...text.matchAll(SCRIPT)].map((m) => ({
				code: m[1] ?? '',
				offset: m.index + m[0].indexOf('>') + 1
			}))
		: [{ code: text, offset: 0 }];

/** Every source finding of `sources` (workspace-relative `src/**` path → text). */
export function sourceRules(
	m: EngineManifest,
	sources: ReadonlyMap<string, string>,
	files: readonly Discovered[]
): Finding[] {
	const out: Finding[] = [];
	for (const [path, text] of sources) {
		const file = files.find((f) => f.path === path);
		const retried =
			file?.role === 'automation' && m.automations[file.name]?.retry !== undefined;
		// only a job's run waits: a call, an effect or any other body has no run to wait in
		const waits = file?.role === 'automation' && m.automations[file.name]?.mode !== 'call';
		const capped = CAPPED.test(path);
		const lineOf = (at: number) => text.slice(0, at).split('\n').length;
		for (const { code, offset } of scripts(path, text)) {
			const { program, errors } = parseSync(`${path}.ts`, code);
			if (errors.length > 0) continue; // the bundle and type stages name a syntax error
			const at = (rule: string, node: Span, message: string) => {
				const line = lineOf(offset + node.start);
				out.push({ code: `check/${rule}`, path, line, message: `${path}:${line}: ${message}` });
			};
			const source = (n: Span) => code.slice(n.start, n.end);
			const functions: Span[] = [],
				tries: Span[] = [],
				loops: Span[] = [],
				yields: number[] = [],
				acts: number[] = [],
				branches: (readonly [Span, Span])[] = [],
				exited: Span[] = [],
				reads: Span[] = [];
			const wall = (n: ESTree.Expression) => {
				const specifier = n.type === 'Literal' ? String(n.value) : '';
				if (specifier.startsWith('@norbital-ai/bolt/') && !AUTHOR.has(specifier))
					at(
						'author-import',
						n,
						`imports '${specifier}': only the root, /errors and /page are the author contract`
					);
			};
			const fn = (n: Span) => void functions.push(n);
			const loop = (n: { readonly body: Span }) => void loops.push(n.body);
			new Visitor({
				FunctionDeclaration: fn,
				FunctionExpression: fn,
				ArrowFunctionExpression: fn,
				TryStatement: (n) => {
					if (n.handler !== null) tries.push(n.block);
				},
				YieldExpression: (n) => {
					if (!n.delegate) return;
					yields.push(n.start);
					const call = n.argument;
					if (call?.type === 'CallExpression' && source(call.callee).replace(/\s+/g, '') === 'ctx.act') acts.push(n.start);
				},
				IfStatement: (n) => {
					if (n.alternate !== null) branches.push([n.consequent, n.alternate]);
					else if (exits(n.consequent)) exited.push(n.consequent);
				},
				ConditionalExpression: (n) => void branches.push([n.consequent, n.alternate]),
				ForStatement: loop,
				ForInStatement: loop,
				ForOfStatement: loop,
				WhileStatement: loop,
				DoWhileStatement: loop,
				LogicalExpression: (n) => {
					const left = member(n.left), right = member(n.right);
					const set = left && member(left.object), before = right && member(right.object);
					if (
						n.operator === '??' &&
						left?.name === right?.name &&
						set?.name === 'set' &&
						before?.name === 'before' &&
						source(set.object) === source(before.object)
					)
						at('set-before', n, `${source(n)}: read ${source(set.object)}.after.${left?.name}`);
				},
				CallExpression: (n) => {
					const callee = source(n.callee).replace(/\s+/g, '');
					if (/^ctx\.query(\.\w+)?$/.test(callee)) reads.push(n);
					if (callee === 'ctx.wait' && !waits)
						at('wait-job', n, 'ctx.wait waits in a job automation only: a call, an effect or another body has no run to wait in');
					if (callee === 'ctx.act' && retried && n.arguments.length === 1)
						at('act-retry-key', n, 'a retried run repeats an act without a key: pass { key }');
					const name = member(n.callee)?.name;
					const body = n.arguments[0];
					if (
						name !== undefined &&
						ITERATORS.has(name) &&
						(body?.type === 'FunctionExpression' || body?.type === 'ArrowFunctionExpression')
					)
						loops.push(body);
				},
				ImportDeclaration: (n) => wall(n.source),
				ExportNamedDeclaration: (n) => {
					if (n.source !== null) wall(n.source);
				},
				ExportAllDeclaration: (n) => wall(n.source),
				ImportExpression: (n) => {
					wall(n.source);
				}
			}).visit(program);
			// two acts with nothing yielded between them (not the two arms of one if or ?:, nor after a branch that exits) commit apart: one act map commits together
			const apart = (a: number, b: number) =>
				branches.some(([x, y]) => (within(x, a) && within(y, b)) || (within(y, a) && within(x, b))) ||
				exited.some((x) => within(x, a) && !within(x, b));
			for (const [i, a] of acts.entries()) {
				const b = acts[i + 1];
				if (b === undefined || innermost(functions, a) !== innermost(functions, b) || apart(a, b)) continue;
				if (!yields.some((y) => y > a && y < b && innermost(functions, y) === innermost(functions, a)))
					at('act-split', { start: b, end: b + 1 }, 'these acts commit one after another, so the first can stand alone: put them in one act map to commit together');
			}
			for (const t of tries) {
				const owner = innermost(functions, t.start);
				if (yields.some((y) => within(t, y) && innermost(functions, y) === owner))
					at(
						'try-yield',
						t,
						'a failed yield* ends the body; try/catch never sees it: recover with Effect.catch/catchTag on the yielded Effect'
					);
			}
			if (capped)
				for (const r of reads)
					if (loops.some((l) => within(l, r.start)))
						at(
							'read-in-loop',
							r,
							'a write callback/verdict reads at most 10 times per call: read the whole batch once'
						);
		}
	}
	return out;
}

