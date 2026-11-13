import { item_kind, type Fields, type Kind, type OutputKind, type Value } from '@norbital-ai/store/kind';
import { Array as EffectArray, Predicate } from 'effect';
import { BUILTIN_FIELDS } from '../../decl/builtin-fields.ts';
import type { EngineManifest } from '../manifest.ts';

export const customShape = (fields: EngineManifest['custom_fields'] | undefined, name: string): Kind | undefined =>
	fields?.[name]?.shape ?? Object.entries(BUILTIN_FIELDS).find(([key]) => key === name)?.[1].spec.shape;

type Child<K, V> = { readonly kind: K; readonly value: V; readonly path: string; readonly key: string | undefined };
type Options = {
	readonly custom_fields?: EngineManifest['custom_fields'];
	readonly rowFields?: (model: string) => Fields | undefined;
	/** Raw diagnostics follow input key order; decoded discovery follows declaration order. */
	readonly raw?: true;
	readonly union?: (arms: readonly Kind[], value: unknown, path: string) => Kind | undefined;
};

export function kindChildren(kind: Kind, value: Value, path: string, options?: Options): readonly Child<Kind, Value>[];
export function kindChildren(kind: Kind, value: unknown, path: string, options?: Options): readonly Child<Kind, unknown>[];
export function kindChildren(kind: OutputKind, value: Value, path: string, options?: Options): readonly Child<OutputKind, Value>[];
export function kindChildren(kind: OutputKind, value: unknown, path: string, options?: Options): readonly Child<OutputKind, unknown>[];
/** One structural traversal for raw diagnostics, decoded references and declared output files. */
export function kindChildren(kind: OutputKind, value: unknown, path: string, options: Options = {}): readonly Child<OutputKind, unknown>[] {
	if (value == null) return [];
	const child = (kind: OutputKind, value: unknown, key?: string): Child<OutputKind, unknown> => ({
		kind, value, key, path: key === undefined ? path : path === '' ? key : `${path}.${key}`
	});
	if (kind.many === true)
		return EffectArray.isArray(value) ? value.map((item, index) => child(item_kind(kind), item, String(index))) : [];
	const object = Predicate.isObject(value) && !EffectArray.isArray(value) ? value : undefined;
	const fields = (named: Readonly<Record<string, OutputKind>>, rest?: OutputKind) => {
		if (object === undefined) return [];
		if (options.raw === true)
			return Object.entries(object).flatMap(([key, item]) => {
				const kind = named[key] ?? rest;
				return kind === undefined ? [] : [child(kind, item, key)];
			});
		return [
			...Object.entries(named).flatMap(([key, kind]) => object[key] === undefined ? [] : [child(kind, object[key], key)]),
			...(rest === undefined ? [] : Object.entries(object).flatMap(([key, item]) => Object.hasOwn(named, key) ? [] : [child(rest, item, key)]))
		];
	};
	switch (kind.kind) {
		case 'row': return fields(options.rowFields?.(kind.of) ?? {});
		case 'custom': {
			const shape = customShape(options.custom_fields, kind.of);
			return shape === undefined ? [] : [child(shape, value)];
		}
		case 'json': return kind.shape === undefined ? [] : [child(kind.shape, value)];
		case 'record': return object === undefined ? [] : Object.entries(object).map(([key, item]) => child(kind.of, item, key));
		case 'object': return fields(kind.fields, kind.rest);
		case 'union': {
			if ('of' in kind) {
				const arm = options.union?.(kind.of, value, path);
				return arm === undefined ? [] : [child(arm, value)];
			}
			const tag = object?.[kind.by], arm = typeof tag === 'string' ? kind.arms[tag] : undefined;
			return arm === undefined ? [] : [child({ kind: 'object', fields: arm }, value)];
		}
		default: return [];
	}
}
