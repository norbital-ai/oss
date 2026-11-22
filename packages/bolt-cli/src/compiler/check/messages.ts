// The message checks: English is the workspace basis, every declared language carries a catalog mirroring every base
// key (and naming no unknown key), and static `t('...')` / `ctx.t('...')` calls reference declared keys.
import { Result } from 'effect';
import { parse as parseSvelte } from 'svelte/compiler';
import { parseSync } from 'vite';
import type { EngineManifest } from '@norbital-ai/bolt/engine';
import { framework_keys, is_native_locale, SYSTEM } from '@norbital-ai/bolt/tooling';
import type { Discovered } from '../discover.ts';
import type { Finding } from './rules.ts';

const FRAMEWORK_KEYS = new Set(framework_keys());
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const ALLOW_UNDECLARED =
	/(?:repository-health|bolt-check):allow\s+[^\n]*\b(?:check\/)?messages-undeclared-key\b/;

const placeholdersOf = (text: string): string =>
	[...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? ''))].sort().join(',');

/** A native model caption: the base may omit it (the view humanizes the name); a locale may still translate it. */
const native = (key: string): boolean =>
	/^models\.[^.]+\.(label|singular)$/.test(key) ||
	/^models\.[^.]+\.fields\.[^.]+(\.[^.]+)?$/.test(key);

/** Whether a locale-only native key names a declared model, field, or one of its enum/state values. */
function declared(m: EngineManifest, key: string, includeSystem = false): boolean {
	const parts = key.split('.');
	if (parts[0] !== 'models') return false;
	const name = parts[1] ?? '';
	const model = m.models[name] ?? (includeSystem ? SYSTEM.models[name] : undefined);
	if (model === undefined) return false;
	if (parts.length === 3) return parts[2] === 'label' || parts[2] === 'singular';
	if (parts[2] !== 'fields') return false;
	const field = model.fields[parts[3] ?? ''];
	if (field === undefined) return false;
	if (parts.length === 4) return true;
	const value = parts[4] ?? '';
	return field.kind === 'enum'
		? (field.values ?? []).includes(value)
		: field.kind === 'state'
			? Object.hasOwn(field.states ?? {}, value)
			: false;
}

const isNode = (value: unknown): value is { readonly type: string } & Record<string, unknown> =>
	typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

/** The static keys and literal string values of a `messages({ … })` object; a computed key cannot be translated. */
function catalog(
	text: string,
	path: string
): {
	keys: string[];
	entries: Map<string, { readonly value: string; readonly start: number }>;
	computed: number[];
} {
	const { program } = parseSync(`${path}.ts`, text);
	const out: string[] = [],
		entries = new Map<string, { readonly value: string; readonly start: number }>(),
		computed: number[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) return value.forEach(visit);
		if (!isNode(value)) return;
		if (value.type === 'CallExpression') {
			const call = value,
				callee = call.callee,
				args = call.arguments;
			if (
				isNode(callee) &&
				callee.type === 'Identifier' &&
				callee.name === 'messages' &&
				Array.isArray(args) &&
				args.length === 1
			) {
				const object = args[0];
				if (
					isNode(object) &&
					object.type === 'ObjectExpression' &&
					Array.isArray(object.properties)
				)
					for (const property of object.properties) {
						if (!isNode(property) || property.type !== 'Property') continue;
						const key = property.key;
						let name: string | undefined;
						if (isNode(key) && key.type === 'Literal' && typeof key.value === 'string')
							name = key.value;
						else if (isNode(key) && key.type === 'Identifier' && typeof key.name === 'string')
							name = key.name;
						else if (typeof property.start === 'number') computed.push(property.start);
						if (name !== undefined) {
							out.push(name);
							const val = property.value;
							if (
								isNode(val) &&
								val.type === 'Literal' &&
								typeof val.value === 'string' &&
								typeof val.start === 'number'
							)
								entries.set(name, { value: val.value, start: val.start });
						}
					}
			}
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(program);
	return { keys: out, entries, computed };
}

const isTranslateCallee = (callee: unknown): boolean => {
	if (!isNode(callee)) return false;
	const inner = callee.type === 'ChainExpression' ? callee.expression : callee;
	if (!isNode(inner)) return false;
	if (inner.type === 'Identifier' && inner.name === 't') return true;
	return (
		inner.type === 'MemberExpression' &&
		inner.computed !== true &&
		isNode(inner.property) &&
		inner.property.type === 'Identifier' &&
		isNode(inner.object) &&
		inner.object.type === 'Identifier' &&
		((inner.property.name === 't' && (inner.object.name === 'ctx' || inner.object.name === 'bolt')) ||
			(inner.property.name === 'refuse' && inner.object.name === 'ctx'))
	);
};

const literalKeys = (arg: unknown, out: { key: string; start: number }[]): void => {
	if (!isNode(arg)) return;
	if (arg.type === 'Literal' && typeof arg.value === 'string' && typeof arg.start === 'number') {
		out.push({ key: arg.value, start: arg.start });
		return;
	}
	if (arg.type === 'ConditionalExpression') {
		literalKeys(arg.consequent, out);
		literalKeys(arg.alternate, out);
	}
};

function staticTranslateCalls(path: string, text: string): { key: string; start: number }[] {
	const found: { key: string; start: number }[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isNode(value)) return;
		if (
			value.type === 'CallExpression' &&
			isTranslateCallee(value.callee) &&
			Array.isArray(value.arguments) &&
			value.arguments.length >= 1
		) {
			literalKeys(value.arguments[0], found);
		}
		for (const [k, child] of Object.entries(value)) {
			if (k === 'loc' || k === 'start' || k === 'end' || k === 'type' || k === 'raw') continue;
			visit(child);
		}
	};
	if (path.endsWith('.svelte')) {
		const parsed = Result.try(() => parseSvelte(text, { modern: true }));
		if (Result.isSuccess(parsed)) visit(parsed.success);
	} else {
		const { program, errors } = parseSync(`${path}.ts`, text);
		if (errors.length === 0) visit(program);
	}
	return found.sort((a, b) => a.start - b.start);
}

/** Every source finding about `src/i18n/**` and translation usage (`sources` is the workspace-relative text map). */
export function messageRules(
	files: readonly Discovered[],
	sources: ReadonlyMap<string, string>,
	m: EngineManifest
): Finding[] {
	const out: Finding[] = [];
	const rawLanguages = m.workspace.languages;
	const declaredLanguages = (rawLanguages ?? ['en'])
		.map((l) => l.trim().toLowerCase())
		.filter((l) => l !== '');
	const workspacePath = files.find((f) => f.role === 'workspace')?.path ?? 'src/+workspace.ts';
	if (rawLanguages !== undefined && !declaredLanguages.includes('en')) {
		out.push({
			code: 'check/messages-base-en',
			path: workspacePath,
			message: `${workspacePath}: workspace languages must include 'en' (English is always the workspace basis)`
		});
	}

	const base = files.find((f) => f.role === 'messages');
	const localeFiles = files.filter((f) => f.role === 'locale');
	const nonEn = [...new Set(declaredLanguages.filter((l) => l !== 'en'))];
	if (nonEn.length > 0) {
		if (base === undefined)
			out.push({
				code: 'check/messages-locale-missing',
				path: 'src/i18n/+messages.ts',
				message: `src/i18n/+messages.ts: base English message catalog is missing (workspace declares languages: ${nonEn.join(', ')})`
			});
		const discoveredLocales = new Set(localeFiles.map((f) => f.name.toLowerCase()));
		for (const lang of nonEn)
			if (!discoveredLocales.has(lang))
				out.push({
					code: 'check/messages-locale-missing',
					path: `src/i18n/+${lang}.messages.ts`,
					message: `src/i18n/+${lang}.messages.ts: workspace declares language '${lang}' without a translation catalog`
				});
	}

	if (base === undefined) return out;
	const baseText = sources.get(base.path);
	if (baseText === undefined) return out;
	const baseParsed = catalog(baseText, base.path);
	const baseKeys = new Set(baseParsed.keys);
	const baseLine = (at: number) => baseText.slice(0, at).split('\n').length;
	for (const [key, entry] of baseParsed.entries)
		if (entry.value.trim() === '') {
			const ln = baseLine(entry.start);
			out.push({
				code: 'check/messages-empty',
				path: base.path,
				line: ln,
				message: `${base.path}:${ln}: '${key}' has an empty translation value`
			});
		}
	for (const file of localeFiles) {
		const text = sources.get(file.path);
		if (text === undefined) continue;
		const parsed = catalog(text, file.path);
		const local = new Set(parsed.keys);
		const missing = [...baseKeys].filter((k) => !local.has(k));
		const extra = parsed.keys.filter(
			(k) => !baseKeys.has(k) && !FRAMEWORK_KEYS.has(k) && (!native(k) || !declared(m, k))
		);
		const line = (at: number) => text.slice(0, at).split('\n').length;
		if (missing.length > 0)
			out.push({
				code: 'check/messages-missing',
				path: file.path,
				message: `${file.path}: ${missing.length} base key(s) have no ${file.name} text: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`
			});
		if (!is_native_locale(file.name)) {
			const missingFramework = [...FRAMEWORK_KEYS].filter((k) => !local.has(k));
			if (missingFramework.length > 0)
				out.push({
					code: 'check/messages-framework-missing',
					path: file.path,
					message: `${file.path}: '${file.name}' is not a built-in framework locale; supply all ${missingFramework.length} missing Bolt/UI framework key(s): ${missingFramework.slice(0, 10).join(', ')}${missingFramework.length > 10 ? ', …' : ''}`
				});
		}
		for (const key of new Set(extra)) {
			const at = text.indexOf(`'${key}'`);
			out.push({
				code: 'check/messages-extra',
				path: file.path,
				...(at < 0 ? {} : { line: line(at) }),
				message: `${file.path}: '${key}' is not a base key; add it to +messages.ts or translate an existing key`
			});
		}
		for (const [key, entry] of parsed.entries) {
			if (entry.value.trim() === '') {
				const ln = line(entry.start);
				out.push({
					code: 'check/messages-empty',
					path: file.path,
					line: ln,
					message: `${file.path}:${ln}: '${key}' has an empty translation value`
				});
			}
			const baseEntry = baseParsed.entries.get(key);
			if (baseEntry !== undefined) {
				const expectedPh = placeholdersOf(baseEntry.value);
				const actualPh = placeholdersOf(entry.value);
				if (expectedPh !== actualPh) {
					const ln = line(entry.start);
					out.push({
						code: 'check/messages-placeholders',
						path: file.path,
						line: ln,
						message: `${file.path}:${ln}: '${key}' placeholders {${actualPh}} do not match base {${expectedPh}}`
					});
				}
			}
		}
		for (const at of parsed.computed)
			out.push({
				code: 'check/messages-computed',
				path: file.path,
				line: line(at),
				message: `${file.path}:${line(at)}: a computed key cannot be translated; write the key out`
			});
	}

	const catalogPaths = new Set([base.path, ...localeFiles.map((f) => f.path)]);
	for (const [path, text] of sources) {
		if (catalogPaths.has(path)) continue;
		if (!path.endsWith('.ts') && !path.endsWith('.svelte')) continue;
		const lines = text.split('\n');
		for (const call of staticTranslateCalls(path, text)) {
			if (
				baseKeys.has(call.key) ||
				FRAMEWORK_KEYS.has(call.key) ||
				(native(call.key) && declared(m, call.key, true))
			)
				continue;
			const line = text.slice(0, call.start).split('\n').length;
			if (
				ALLOW_UNDECLARED.test(lines[line - 1] ?? '') ||
				(line >= 2 && ALLOW_UNDECLARED.test(lines[line - 2] ?? ''))
			)
				continue;
			out.push({
				code: 'check/messages-undeclared-key',
				path,
				line,
				message: `${path}:${line}: message key '${call.key}' is not declared in ${base.path}`
			});
		}
	}
	return out;
}
