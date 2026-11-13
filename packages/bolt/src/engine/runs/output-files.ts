import { Option, Schema } from 'effect';
import type { OutputKind, Value } from '@norbital-ai/store/kind';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../manifest.ts';
import { kindChildren } from '../callables/kinds.ts';

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
	custom_fields: EngineManifest['custom_fields'] = {},
	models: EngineManifest['models'] = {}
): readonly OutputFile[] {
	const files = new Map<string, OutputFile>();
	const visit = (
		kind: OutputKind | undefined,
		value: Value | undefined,
		aliases: ReadonlySet<string> = new Set()
	): void => {
		if (kind === undefined || value == null) return;
		let next = aliases;
		if (kind.many !== true && kind.kind === 'custom') {
			if (aliases.has(kind.of)) return;
			next = new Set([...aliases, kind.of]);
		}
		if (kind.many !== true && kind.kind === 'file') {
			const parsed = file(value);
			if (Option.isSome(parsed)) {
				const { id, name, mime } = parsed.value;
				if (!files.has(id)) files.set(id, { id, name, mime });
			}
		}
		for (const child of kindChildren(kind, value, '', { custom_fields, rowFields: (model) => models[model]?.fields }))
			visit(child.kind, child.value, next);
	};
	visit(kind, value);
	return [...files.values()];
}
