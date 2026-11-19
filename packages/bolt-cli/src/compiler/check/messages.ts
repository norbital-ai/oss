// The message checks: every locale carries every base key, and names no key the base does not. A missing key would
// silently fall back to English, so it fails the check instead.
import { parseSync } from 'vite';
import type { EngineManifest } from '@norbital-ai/bolt/engine';
import type { Discovered } from '../discover.ts';
import type { Finding } from './rules.ts';

/** A native model caption: the base may omit it (the view humanizes the name); a locale may still translate it. */
const native = (key: string): boolean =>
	/^models\.[^.]+\.(label|singular)$/.test(key) ||
	/^models\.[^.]+\.fields\.[^.]+(\.[^.]+)?$/.test(key);

/** Whether a locale-only native key names a declared model, field, or one of its enum/state values. */
function declared(m: EngineManifest, key: string): boolean {
	const parts = key.split('.');
	if (parts[0] !== 'models') return false;
	const model = m.models[parts[1] ?? ''];
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

/** The static keys of a `messages({ … })` object; a computed key cannot be translated and is reported. */
function catalog(text: string, path: string): { keys: string[]; computed: number[] } {
	const { program } = parseSync(`${path}.ts`, text);
	const out: string[] = [],
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
						if (isNode(key) && key.type === 'Literal' && typeof key.value === 'string')
							out.push(key.value);
						else if (isNode(key) && key.type === 'Identifier' && typeof key.name === 'string')
							out.push(key.name);
						else if (typeof property.start === 'number') computed.push(property.start);
					}
			}
		}
		for (const child of Object.values(value)) visit(child);
	};
	visit(program);
	return { keys: out, computed };
}

/** Every source finding about `src/i18n/**` (`sources` is the workspace-relative text map). */
export function messageRules(
	files: readonly Discovered[],
	sources: ReadonlyMap<string, string>,
	m: EngineManifest
): Finding[] {
	const out: Finding[] = [];
	const base = files.find((f) => f.role === 'messages');
	if (base === undefined) return out;
	const baseText = sources.get(base.path);
	if (baseText === undefined) return out;
	const baseKeys = new Set(catalog(baseText, base.path).keys);
	for (const file of files.filter((f) => f.role === 'locale')) {
		const text = sources.get(file.path);
		if (text === undefined) continue;
		const parsed = catalog(text, file.path);
		const local = new Set(parsed.keys);
		const missing = [...baseKeys].filter((k) => !local.has(k));
		const extra = parsed.keys.filter((k) => !baseKeys.has(k) && (!native(k) || !declared(m, k)));
		const line = (at: number) => text.slice(0, at).split('\n').length;
		if (missing.length > 0)
			out.push({
				code: 'check/messages-missing',
				path: file.path,
				message: `${file.path}: ${missing.length} base key(s) have no ${file.name} text: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}`
			});
		for (const key of new Set(extra)) {
			const at = text.indexOf(`'${key}'`);
			out.push({
				code: 'check/messages-extra',
				path: file.path,
				...(at < 0 ? {} : { line: line(at) }),
				message: `${file.path}: '${key}' is not a base key; add it to +messages.ts or translate an existing key`
			});
		}
		for (const at of parsed.computed)
			out.push({
				code: 'check/messages-computed',
				path: file.path,
				line: line(at),
				message: `${file.path}:${line(at)}: a computed key cannot be translated; write the key out`
			});
	}
	return out;
}
