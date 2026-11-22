// The source checks: foot-guns whose types pass and whose runtime is wrong, read from each `src/**` module's syntax
// (a component's `<script>` blocks included) with the parser the bundle stage uses, plus static Svelte markup guards.
// A `try` around a `yield*`, a read in a write callback's loop, `set ?? before`, a retried run's unkeyed `act`, two
// acts one after another (separate commits), a `ctx.wait` outside a job, and UX/layout invariants on `.svelte` files.
import { Result } from 'effect';
import { parse as parseSvelte, type AST } from 'svelte/compiler';
import { parseSync, Visitor, type ESTree } from 'vite';
import type { EngineManifest } from '@norbital-ai/bolt/engine';
import type { Discovered } from '../discover.ts';
import type { Finding } from './rules.ts';

const ITERATORS = new Set(['map', 'flatMap', 'forEach', 'filter', 'reduce', 'some', 'every']);
/** Files whose bodies read under the per-call cap: models (write callbacks, effects, syncs) and policies (verdicts). */
const CAPPED = /(^|\/)\+model\.ts$|\.policy\.ts$|(^|\/)\+?[^/]*sync\.ts$/;
const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
const CHART_TAG = /<Chart\b([^>]*?)\/?>/g;
const CHART_MEASURE = /^(?:count|(?:sum|avg|min|max)\.\w+)$/;

const DATA_VIEWS = new Set(['Table', 'Board']);
const REGION_BOUNDARIES = new Set([
	'Sheet',
	'Dialog',
	'Drawer',
	'Modal',
	'AlertDialog',
	'Popover',
	'Tooltip',
	'Sheet.Content',
	'Dialog.Content',
	'Tabs.Content'
]);
const SELF_SIZED_CONTROLS = new Set(['Input', 'Combobox', 'TimeInput', 'Bound']);
const PROSE_COMPONENTS = new Set(['Markdown', 'Prose', 'RichText']);
const PROSE_CLASS = /(?:^|[\s:'"`])prose(?:$|[\s-'"`])/;
const FONT_WEIGHT_BAD = /(?:^|[\s:'"`])(font-(?:semibold|bold))(?=$|[\s'"`])/;
const TEXT_SIZE_BAD = /(?:^|[\s:'"`])(text-(?:lg|xl|2xl|3xl))(?=$|[\s'"`])/;
const TEXT_ARBITRARY_BAD = /(?:^|[\s:'"`])(text-\[[^\s'"`]*)/;
const TEXT_ROLE_TOKEN = /(?:^|[\s:'"`])(text-(?:meta|overline|label|caption|heading|title|section))(?=$|[\s'"`])/;
const LEADING_TOKEN = /(?:^|[\s:'"`])(leading-[^\s'"`]+)/;
const RAW_UNICODE_ICON = /[▲▼ℹ⚠]/;
const SELF_SIZED_CLASS = /(?:^|[\s:'"`])((?:w|h)-(?:\d+(?:\.\d+)?|\[[^\s'"`]*)|min-(?:w|h)-(?:[1-9]\d*(?:\.\d+)?|\[[^\s'"`]*))(?=$|[\s'"`])/;
const TRANSLATABLE_ATTRS = new Set([
	'title',
	'description',
	'label',
	'placeholder',
	'hint',
	'aria-label'
]);
const NON_TRANSLATABLE_ELEMENTS = new Set(['code', 'pre', 'svg', 'kbd', 'samp']);
const CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));
const UNIT_TOKENS = new Set([
	'ha',
	'nm',
	'mm',
	'cm',
	'km',
	'kg',
	'mg',
	'ml',
	'ms',
	'px',
	'bps',
	'kb',
	'mb',
	'gb',
	'tb',
	'hz',
	'khz',
	'mhz'
]);
const URL_OR_EMAIL = /^(?:https?:\/\/|mailto:|tel:)\S+$/i;
const ALPHA_WORDS = /\p{L}+/gu;
const isUntranslatedRawText = (raw: string): boolean => {
	const trimmed = raw.trim();
	if (trimmed === '' || URL_OR_EMAIL.test(trimmed)) return false;
	const words = trimmed.match(ALPHA_WORDS);
	if (words === null) return false;
	const letterCount = words
		.filter((word) => !CURRENCY_CODES.has(word) && !UNIT_TOKENS.has(word.toLowerCase()))
		.reduce((sum, word) => sum + word.length, 0);
	return letterCount >= 2;
};
const ALLOW_COMMENT = /(?:repository-health|bolt-check):allow\s+([^\n]*)/;
const COMMENT_LINE = /^(?:<!--|\/\/|\/\*|\*)|(?:-->|\*\/)$/;

const lineAllows = (lineText: string, rule: string): boolean => {
	const m = ALLOW_COMMENT.exec(lineText);
	if (m === null) return false;
	const head = (m[1] ?? '').split(/--|-->|\*\//)[0] ?? '';
	const tokens = head.trim().split(/[\s,]+/);
	return tokens.includes(rule) || tokens.includes(`check/${rule}`);
};

const isSuppressed = (
	lines: readonly string[],
	rule: string,
	...atLines: readonly (number | undefined)[]
): boolean => {
	for (const line of atLines) {
		if (line === undefined || line < 1 || line > lines.length) continue;
		if (lineAllows(lines[line - 1] ?? '', rule)) return true;
		let inHtmlComment = false;
		for (let i = line - 2; i >= 0; i--) {
			const trimmed = (lines[i] ?? '').trim();
			if (inHtmlComment) {
				if (lineAllows(trimmed, rule)) return true;
				if (trimmed.includes('<!--')) inHtmlComment = false;
				continue;
			}
			if (trimmed === '') break;
			if (trimmed.endsWith('-->') && !trimmed.includes('<!--')) {
				if (lineAllows(trimmed, rule)) return true;
				inHtmlComment = true;
				continue;
			}
			if (!COMMENT_LINE.test(trimmed)) break;
			if (lineAllows(trimmed, rule)) return true;
		}
	}
	return false;
};

type StrChunk = { readonly value: string; readonly start: number };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const exprStrings = (
	node: unknown,
	out: StrChunk[],
	fallbackStart: number,
	includeObjectKeys = false
): void => {
	if (Array.isArray(node)) {
		for (const item of node) exprStrings(item, out, fallbackStart, includeObjectKeys);
		return;
	}
	if (!isRecord(node)) return;
	const type = node.type;
	const start = typeof node.start === 'number' ? node.start : fallbackStart;
	if (type === 'Literal' && typeof node.value === 'string') {
		out.push({ value: node.value, start });
		return;
	}
	if (type === 'TemplateElement' && isRecord(node.value) && typeof node.value.raw === 'string') {
		out.push({ value: node.value.raw, start });
		return;
	}
	if (type === 'Property' && includeObjectKeys) {
		if (!node.computed && isRecord(node.key)) {
			const keyStart = typeof node.key.start === 'number' ? node.key.start : start;
			if (node.key.type === 'Literal' && typeof node.key.value === 'string')
				out.push({ value: node.key.value, start: keyStart });
			else if (node.key.type === 'Identifier' && typeof node.key.name === 'string')
				out.push({ value: node.key.name, start: keyStart });
		}
		exprStrings(node.value, out, start, includeObjectKeys);
		return;
	}
	for (const [k, v] of Object.entries(node)) {
		if (k === 'loc' || k === 'start' || k === 'end' || k === 'type') continue;
		if (type === 'Property' && k === 'key' && !includeObjectKeys) continue;
		exprStrings(v, out, start, includeObjectKeys);
	}
};

type AnyElement = AST.Component | AST.RegularElement | AST.SvelteElement;
type FragmentNode = AST.Fragment['nodes'][number];

const findAttr = (el: AnyElement, name: string): AST.Attribute | undefined => {
	for (const a of el.attributes) if (a.type === 'Attribute' && a.name === name) return a;
	return undefined;
};

const staticAttr = (el: AnyElement, name: string): string | undefined => {
	const a = findAttr(el, name);
	if (a === undefined || a.value === true) return undefined;
	if (Array.isArray(a.value)) {
		if (a.value.every((part): part is AST.Text => part.type === 'Text'))
			return a.value.map((part) => part.data).join('');
		return undefined;
	}
	const expr: unknown = a.value.expression;
	return isRecord(expr) && expr.type === 'Literal' && typeof expr.value === 'string'
		? expr.value
		: undefined;
};

const boolAttr = (el: AnyElement, name: string): boolean => {
	const a = findAttr(el, name);
	if (a === undefined) return false;
	if (a.value === true || Array.isArray(a.value)) return true;
	const expr: unknown = a.value.expression;
	return !(isRecord(expr) && expr.type === 'Literal' && expr.value === false);
};

const classStrings = (el: AnyElement, text: string): StrChunk[] => {
	const chunks: StrChunk[] = [];
	for (const a of el.attributes) {
		if (a.type === 'Attribute' && (a.name === 'class' || a.name.endsWith('_class'))) {
			if (Array.isArray(a.value)) {
				const staticParts: string[] = [];
				for (const part of a.value) {
					if (part.type === 'Text') staticParts.push(part.data);
					else exprStrings(part.expression, chunks, part.start, true);
				}
				const joined = staticParts.join(' ');
				if (joined.trim() !== '') chunks.push({ value: joined, start: a.start });
			} else if (a.value !== true) {
				exprStrings(a.value.expression, chunks, a.start, true);
			}
		} else if (a.type === 'ClassDirective') {
			const m = /^class:([^\s=/>]+)/.exec(text.slice(a.start, a.end));
			if (m?.[1] !== undefined) chunks.push({ value: m[1], start: a.start });
		}
	}
	return chunks;
};

const isProseContainer = (el: AnyElement, classes: readonly StrChunk[]): boolean =>
	(el.type === 'Component' &&
		(PROSE_COMPONENTS.has(el.name) ||
			el.name.endsWith('Markdown') ||
			el.name.endsWith('Prose'))) ||
	classes.some((c) => PROSE_CLASS.test(c.value));

const isSignificantBodyNode = (node: FragmentNode): boolean => {
	if (node.type === 'Comment' || node.type === 'SnippetBlock') return false;
	if (node.type === 'Text' && node.data.trim() === '') return false;
	if (node.type === 'Component' && REGION_BOUNDARIES.has(node.name)) return false;
	return true;
};

const isEmptyOrStateOnly = (nodes: readonly FragmentNode[]): boolean => {
	const sig = nodes.filter(isSignificantBodyNode);
	if (sig.length === 0) return true;
	const only = sig[0];
	return sig.length === 1 && only !== undefined && only.type === 'Component' && only.name === 'EmptyState';
};

/** Returns the sole `<Table>` if `nodes` renders a single `<Table>` as its body (including behind `#key` or an `#if`/`EmptyState` gate). */
const singleTableBody = (nodes: readonly FragmentNode[]): AST.Component | undefined => {
	const sig = nodes.filter(isSignificantBodyNode);
	if (sig.length !== 1) return undefined;
	const only = sig[0];
	if (only === undefined) return undefined;
	if (only.type === 'Component' && only.name === 'Table') return only;
	if (only.type === 'KeyBlock') return singleTableBody(only.fragment.nodes);
	if (only.type === 'IfBlock') {
		const a = singleTableBody(only.consequent.nodes);
		const b = only.alternate === null ? undefined : singleTableBody(only.alternate.nodes);
		if (a !== undefined && (only.alternate === null || b !== undefined || isEmptyOrStateOnly(only.alternate.nodes)))
			return a;
		if (b !== undefined && isEmptyOrStateOnly(only.consequent.nodes)) return b;
	}
	return undefined;
};

/** Direct `<Scroll>` body children of an element, unwrapping control-flow blocks and skipping snippets. */
const directBodyScrolls = (nodes: readonly FragmentNode[], out: AST.Component[]): void => {
	for (const node of nodes) {
		if (node.type === 'SnippetBlock') continue;
		if (node.type === 'Component' && node.name === 'Scroll') {
			out.push(node);
		} else if (node.type === 'IfBlock') {
			directBodyScrolls(node.consequent.nodes, out);
			if (node.alternate !== null) directBodyScrolls(node.alternate.nodes, out);
		} else if (node.type === 'KeyBlock') {
			directBodyScrolls(node.fragment.nodes, out);
		} else if (node.type === 'EachBlock') {
			directBodyScrolls(node.body.nodes, out);
			if (node.fallback !== undefined) directBodyScrolls(node.fallback.nodes, out);
		} else if (node.type === 'AwaitBlock') {
			if (node.pending !== null) directBodyScrolls(node.pending.nodes, out);
			if (node.then !== null) directBodyScrolls(node.then.nodes, out);
			if (node.catch !== null) directBodyScrolls(node.catch.nodes, out);
		}
	}
};

type WalkCtx = {
	readonly inProse: boolean;
	readonly skipUntranslated: boolean;
	readonly viewportBoundLine: number | undefined;
	readonly scrollLine: number | undefined;
	readonly directUnderScroll: boolean;
	readonly inScrollViewportBound: boolean;
};

const ROOT_CTX: WalkCtx = {
	inProse: false,
	skipUntranslated: false,
	viewportBoundLine: undefined,
	scrollLine: undefined,
	directUnderScroll: false,
	inScrollViewportBound: false
};

function checkSvelteMarkup(
	path: string,
	text: string,
	lineOf: (at: number) => number,
	lines: readonly string[],
	out: Finding[],
	multiLanguage: boolean
): void {
	const parsed = Result.try(() => parseSvelte(text, { modern: true }));
	if (Result.isFailure(parsed)) return;
	const emit = (rule: string, at: number, message: string, extraLine?: number) => {
		const line = lineOf(at);
		if (isSuppressed(lines, rule, line, extraLine)) return;
		out.push({ code: `check/${rule}`, path, line, message: `${path}:${line}: ${message}` });
	};

	const walkDataViews = (
		nodes: readonly FragmentNode[],
		prior: AST.Component | undefined
	): AST.Component | undefined => {
		let seen = prior;
		for (const node of nodes) {
			if (node.type === 'SnippetBlock') {
				walkDataViews(node.body.nodes, undefined);
			} else if (node.type === 'Component') {
				if (REGION_BOUNDARIES.has(node.name)) {
					walkDataViews(node.fragment.nodes, undefined);
				} else if (DATA_VIEWS.has(node.name)) {
					if (seen !== undefined)
						emit(
							'single-data-view',
							node.start,
							`at most one <Table> or <Board> may render simultaneously in the same view (already rendered <${seen.name}> on line ${lineOf(seen.start)}); separate distinct lists into tabs`
						);
					else seen = node;
					for (const inner of node.fragment.nodes)
						if (inner.type === 'SnippetBlock') walkDataViews(inner.body.nodes, undefined);
				} else {
					seen = walkDataViews(node.fragment.nodes, seen);
				}
			} else if (node.type === 'RegularElement' || node.type === 'SvelteElement' || node.type === 'KeyBlock') {
				seen = walkDataViews(node.fragment.nodes, seen);
			} else if (node.type === 'IfBlock') {
				const a = walkDataViews(node.consequent.nodes, seen);
				const b = node.alternate === null ? seen : walkDataViews(node.alternate.nodes, seen);
				seen = a ?? b;
			} else if (node.type === 'AwaitBlock') {
				const a = node.pending === null ? seen : walkDataViews(node.pending.nodes, seen);
				const b = node.then === null ? seen : walkDataViews(node.then.nodes, seen);
				const c = node.catch === null ? seen : walkDataViews(node.catch.nodes, seen);
				seen = a ?? b ?? c;
			} else if (node.type === 'EachBlock') {
				const a = walkDataViews(node.body.nodes, seen);
				const b = node.fallback === undefined ? seen : walkDataViews(node.fallback.nodes, seen);
				seen = a ?? b;
			}
		}
		return seen;
	};
	walkDataViews(parsed.success.fragment.nodes, undefined);

	const checkUnicode = (chunk: StrChunk) => {
		const m = RAW_UNICODE_ICON.exec(chunk.value);
		if (m !== null)
			emit(
				'raw-unicode-icons',
				chunk.start + m.index,
				`use a Lucide <Icon> instead of raw glyph '${m[0]}'`
			);
	};

	const walk = (nodes: readonly FragmentNode[], ctx: WalkCtx): void => {
		for (const node of nodes) {
			if (node.type === 'Text') {
				checkUnicode({ value: node.data, start: node.start });
				if (multiLanguage && !ctx.skipUntranslated && isUntranslatedRawText(node.data)) {
					const leading = node.data.length - node.data.trimStart().length;
					const preview = node.data.trim().slice(0, 40);
					emit(
						'untranslated-text',
						node.start + leading,
						`raw text '${preview}' should use ctx.t(...) instead of a literal string`
					);
				}
			} else if (node.type === 'ExpressionTag') {
				const strs: StrChunk[] = [];
				exprStrings(node.expression, strs, node.start, false);
				for (const s of strs) checkUnicode(s);
			} else if (node.type === 'SnippetBlock') {
				walk(node.body.nodes, { ...ROOT_CTX, skipUntranslated: ctx.skipUntranslated });
			} else if (node.type === 'IfBlock') {
				walk(node.consequent.nodes, ctx);
				if (node.alternate !== null) walk(node.alternate.nodes, ctx);
			} else if (node.type === 'EachBlock') {
				walk(node.body.nodes, ctx);
				if (node.fallback !== undefined) walk(node.fallback.nodes, ctx);
			} else if (node.type === 'AwaitBlock') {
				if (node.pending !== null) walk(node.pending.nodes, ctx);
				if (node.then !== null) walk(node.then.nodes, ctx);
				if (node.catch !== null) walk(node.catch.nodes, ctx);
			} else if (node.type === 'KeyBlock') {
				walk(node.fragment.nodes, ctx);
			} else if (
				node.type === 'Component' ||
				node.type === 'RegularElement' ||
				node.type === 'SvelteElement'
			) {
				const elementLine = lineOf(node.start);
				const skipUntranslated =
					ctx.skipUntranslated ||
					(node.type === 'RegularElement' && NON_TRANSLATABLE_ELEMENTS.has(node.name)) ||
					staticAttr(node, 'aria-hidden') === 'true' ||
					isSuppressed(lines, 'untranslated-text', elementLine);
				const classes = classStrings(node, text);
				for (const a of node.attributes) {
					if (a.type !== 'Attribute' || a.value === true || a.name === 'class' || a.name.endsWith('_class'))
						continue;
					if (Array.isArray(a.value)) {
						for (const part of a.value) {
							if (part.type === 'Text') {
								checkUnicode({ value: part.data, start: part.start });
								if (
									multiLanguage &&
									!skipUntranslated &&
									TRANSLATABLE_ATTRS.has(a.name) &&
									!(node.type === 'Component' && node.name === 'Map' && a.name === 'label') &&
									isUntranslatedRawText(part.data)
								) {
									const preview = part.data.trim().slice(0, 40);
									emit(
										'untranslated-text',
										part.start,
										`attribute ${a.name}='${preview}' should use ctx.t(...) instead of a literal string`,
										elementLine
									);
								}
							} else {
								const strs: StrChunk[] = [];
								exprStrings(part.expression, strs, part.start, false);
								for (const s of strs) checkUnicode(s);
							}
						}
					} else {
						const strs: StrChunk[] = [];
						exprStrings(a.value.expression, strs, a.start, false);
						for (const s of strs) checkUnicode(s);
					}
				}
				for (const c of classes) {
					const weight = FONT_WEIGHT_BAD.exec(c.value);
					if (weight !== null)
						emit(
							'typography-tokens',
							c.start,
							`avoid '${weight[1]}'; use typography roles or font-medium`
						);
					const size = TEXT_SIZE_BAD.exec(c.value);
					if (size !== null)
						emit(
							'typography-tokens',
							c.start,
							`avoid '${size[1]}'; use typography tokens (text-title, text-section, text-subhead, text-heading)`
						);
					const arbitrary = TEXT_ARBITRARY_BAD.exec(c.value);
					if (arbitrary !== null)
						emit(
							'typography-tokens',
							c.start,
							`avoid arbitrary text token '${arbitrary[1]}'; use typography roles and semantic colour tokens`
						);
					const role = TEXT_ROLE_TOKEN.exec(c.value);
					const leading = role === null ? null : LEADING_TOKEN.exec(c.value);
					if (role !== null && leading !== null)
						emit(
							'typography-tokens',
							c.start,
							`do not pair '${role[1]}' with '${leading[1]}'; typography roles set their own leading`
						);
				}
				if (node.type === 'RegularElement') {
					if (node.name === 'select')
						emit('raw-select', node.start, 'use <Combobox> or <Select> instead of raw <select>');
					if ((node.name === 'b' || node.name === 'strong') && !ctx.inProse)
						emit(
							'typography-tokens',
							node.start,
							`avoid <${node.name}> outside prose/markdown; use typography roles or font-medium`
						);
				} else if (node.type === 'Component') {
					if (SELF_SIZED_CONTROLS.has(node.name)) {
						for (const c of classes) {
							const fixed = SELF_SIZED_CLASS.exec(c.value);
							if (fixed !== null)
								emit(
									'self-sized-control',
									c.start,
									`avoid fixed self-sizing class '${fixed[1]}' on <${node.name}>; size controls from their parent layout`
								);
						}
					}
					if (node.name === 'Chart' && ctx.viewportBoundLine !== undefined)
						emit(
							'chart-viewport',
							node.start,
							'do not wrap <Chart> in <Bound size="viewport">; give charts a bounded panel height (~16–20rem)',
							ctx.viewportBoundLine
						);
					if (ctx.directUnderScroll && (node.name === 'Tabs' || node.name === 'Form'))
						emit(
							'scroll-ownership',
							node.start,
							`<Scroll> must not directly wrap <${node.name}>`,
							ctx.scrollLine
						);
					if (
						ctx.scrollLine !== undefined &&
						node.name === 'Table' &&
						!boolAttr(node, 'embedded') &&
						!ctx.inScrollViewportBound
					)
						emit(
							'scroll-ownership',
							node.start,
							'non-embedded <Table> inside <Scroll> must be wrapped in <Bound size="viewport"> or moved outside <Scroll>',
							ctx.scrollLine
						);
					if (node.name === 'AppShell' && staticAttr(node, 'variant') === 'full') {
						const shellLine = lineOf(node.start);
						const scrolls: AST.Component[] = [];
						directBodyScrolls(node.fragment.nodes, scrolls);
						for (const scroll of scrolls)
							if (staticAttr(scroll, 'axis') !== 'x' && !boolAttr(scroll, 'inset'))
								emit(
									'scroll-ownership',
									scroll.start,
									'<Scroll> directly under <AppShell variant="full"> must set inset',
									shellLine
								);
						const table = singleTableBody(node.fragment.nodes);
						if (table !== undefined)
							emit(
								'app-shell-inset',
								node.start,
								'<AppShell variant="full"> wrapping a single <Table> drops page inset; omit variant="full" or wrap in <Bound size="fill" inset>',
								lineOf(table.start)
							);
					}
				}
				const prose = isProseContainer(node, classes);
				if (node.type === 'Component' && REGION_BOUNDARIES.has(node.name)) {
					walk(node.fragment.nodes, { ...ROOT_CTX, inProse: prose, skipUntranslated });
				} else {
					const isViewportBound =
						node.type === 'Component' &&
						node.name === 'Bound' &&
						staticAttr(node, 'size') === 'viewport';
					const isVerticalScroll =
						node.type === 'Component' &&
						node.name === 'Scroll' &&
						staticAttr(node, 'axis') !== 'x';
					walk(node.fragment.nodes, {
						inProse: ctx.inProse || prose,
						skipUntranslated,
						viewportBoundLine: isViewportBound ? lineOf(node.start) : ctx.viewportBoundLine,
						scrollLine: isVerticalScroll ? lineOf(node.start) : ctx.scrollLine,
						directUnderScroll: isVerticalScroll,
						inScrollViewportBound: isVerticalScroll
							? false
							: ctx.inScrollViewportBound || (ctx.scrollLine !== undefined && isViewportBound)
					});
				}
			}
		}
	};
	walk(parsed.success.fragment.nodes, ROOT_CTX);
}

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
	const multiLanguage = (m.workspace.languages ?? ['en']).length > 1;
	for (const [path, text] of sources) {
		const file = files.find((f) => f.path === path);
		const retried =
			file?.role === 'automation' && m.automations[file.name]?.retry !== undefined;
		// only a job's run waits: a call, an effect or any other body has no run to wait in
		const waits = file?.role === 'automation' && m.automations[file.name]?.mode !== 'call';
		const capped = CAPPED.test(path);
		const lines = text.split('\n');
		const lineOf = (at: number) => text.slice(0, at).split('\n').length;
		for (const { code, offset } of scripts(path, text)) {
			const { program, errors } = parseSync(`${path}.ts`, code);
			if (errors.length > 0) continue; // the bundle and type stages name a syntax error
			const at = (rule: string, node: Span, message: string) => {
				const line = lineOf(offset + node.start);
				if (isSuppressed(lines, rule, line)) return;
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
				Property: (n) => {
					const key =
						!n.computed && n.key.type === 'Identifier'
							? n.key.name
							: n.key.type === 'Literal' && typeof n.key.value === 'string'
								? n.key.value
								: undefined;
					if (key !== 'order_by' || n.value.type !== 'ArrayExpression') return;
					const bare = n.value.elements.find(
						(el) => el?.type === 'Literal' && typeof el.value === 'string'
					);
					if (bare !== undefined)
						at(
							'order-by-shape',
							n.value,
							"order_by takes { <field>: 'asc' | 'desc' } entries (e.g. [{ created_at: 'desc' }]), not bare field strings"
						);
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
		if (path.endsWith('.svelte')) {
			for (const match of text.matchAll(CHART_TAG)) {
				const attrs = match[1] ?? '';
				const ofMatch = /\bof\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(attrs);
				const modelName = ofMatch?.[1] ?? ofMatch?.[2];
				if (modelName === undefined || !(modelName in m.models)) continue;
				const ySingle = /\by\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(attrs);
				const yList = /\by\s*=\s*\{\s*\[([^\]]+)\]\s*\}/.exec(attrs);
				const measures =
					ySingle !== null
						? [ySingle[1] ?? ySingle[2] ?? '']
						: yList !== null
							? [...(yList[1] ?? '').matchAll(/["']([^"']+)["']/g)].map((k) => k[1] ?? '')
							: [];
				const bad = measures.find((measure) => measure !== '' && !CHART_MEASURE.test(measure));
				if (bad !== undefined) {
					const line = lineOf(match.index);
					if (!isSuppressed(lines, 'chart-measure', line))
						out.push({
							code: 'check/chart-measure',
							path,
							line,
							message: `${path}:${line}: <Chart of="${modelName}"> expects y to be 'count' or '<sum|avg|min|max>.<field>' (got '${bad}')`
						});
				}
			}
			checkSvelteMarkup(path, text, lineOf, lines, out, multiLanguage);
		}
	}
	return out;
}

