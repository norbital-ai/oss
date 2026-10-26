import { Array as EffectArray, Option, Predicate, Schema } from 'effect';
import { BUILTIN_FIELDS } from '../../decl/builtin-fields.ts';
import type { OutputKind } from '../../decl/fields.ts';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../manifest.ts';

const File = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	mime: Schema.NonEmptyString,
	size: Schema.optionalKey(Schema.Int),
	bytes: Schema.optionalKey(Schema.Int),
	sha256: Schema.optionalKey(Schema.String)
});
type OutputFile = Pick<typeof File.Type, 'id' | 'name' | 'mime'>;
const file = Schema.decodeUnknownOption(File, { onExcessProperty: 'error' });

/** Stored handles in declared file leaves; opaque JSON never grants file access. */
export function outputFiles(
	kind: OutputKind | undefined,
	value: Json | undefined,
	customFields: EngineManifest['customFields'] = {},
	models: EngineManifest['models'] = {}
): readonly OutputFile[] {
	const files = new Map<string, OutputFile>();
	const visit = (
		kind: OutputKind | undefined,
		value: Json | undefined,
		aliases: ReadonlySet<string> = new Set()
	): void => {
		if (kind === undefined || value == null) return;
		switch (kind.kind) {
			case 'row':
				if (Predicate.isObject(value) && !EffectArray.isArray<typeof value>(value))
					for (const [name, field] of Object.entries(models[kind.of]?.fields ?? {}))
						visit(field, value[name], aliases);
				break;
			case 'file': {
				const values = kind.multiple
					? EffectArray.isArray<typeof value>(value)
						? value
						: []
					: [value];
				for (const value of values) {
					const parsed = file(value);
					if (Option.isSome(parsed)) {
						const { id, name, mime } = parsed.value;
						if (!files.has(id)) files.set(id, { id, name, mime });
					}
				}
				break;
			}
			case 'custom': {
				if (aliases.has(kind.of)) return;
				const shape =
					customFields[kind.of]?.shape ??
					Object.entries(BUILTIN_FIELDS).find(([name]) => name === kind.of)?.[1].spec.shape;
				const next = new Set([...aliases, kind.of]);
				if (kind.many) {
					if (EffectArray.isArray<typeof value>(value))
						for (const item of value) visit(shape, item, next);
				} else visit(shape, value, next);
				break;
			}
			case 'json':
				visit(kind.shape, value, aliases);
				break;
			case 'list':
				if (EffectArray.isArray<typeof value>(value))
					for (const item of value) visit(kind.of, item, aliases);
				break;
			case 'record':
				if (Predicate.isObject(value))
					for (const item of Object.values(value)) visit(kind.of, item, aliases);
				break;
			case 'object':
				if (Predicate.isObject(value)) {
					for (const [name, field] of Object.entries(kind.fields))
						visit(field, value[name], aliases);
					if (kind.rest !== undefined)
						for (const [name, item] of Object.entries(value))
							if (!Object.hasOwn(kind.fields, name)) visit(kind.rest, item, aliases);
				}
				break;
			case 'union':
				if ('arms' in kind && Predicate.isObject(value)) {
					const tag = value[kind.by];
					if (typeof tag !== 'string' || !Object.hasOwn(kind.arms, tag)) return;
					for (const [name, field] of Object.entries(kind.arms[tag] ?? {}))
						if (name !== kind.by) visit(field, value[name], aliases);
				}
		}
	};
	visit(kind, value);
	return [...files.values()];
}
