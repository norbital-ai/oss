// The source owner resolves rows/custom fields once into the same portable result contract every consumer decodes.
import { Effect, Schema } from 'effect';
import { default_fields } from '@norbital-ai/store';
import type { OutputKind } from '@norbital-ai/store/kind';
import { encode_wire, type Json, type Wired } from '@norbital-ai/store/wire';
import { nullable_of_expr } from '../../decl/model.ts';
import { kind_output, output_value, type OutputContract, type OutputValueContract, type OutputField } from '../../protocol/output-contract.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalog_of } from '../access/pred.ts';
import type { EngineManifest } from '../manifest.ts';
import { customShape } from './kinds.ts';
import { SYSTEM } from '../../system/index.ts';

/** Exact declared result shape. A void result is the wire's null marker, never an arbitrary discarded value. */
export function output_contract(manifest: EngineManifest, output: OutputKind | undefined): OutputContract {
	if (output === undefined) return { kind: 'void' };
	const models = { ...SYSTEM.models, ...manifest.models };
	const relationships = { ...SYSTEM.relationships, ...manifest.relationships };
	return kind_output(output, (value, resolve): OutputValueContract => {
		if (value.kind === 'custom') {
			const shape = customShape(manifest.custom_fields, value.of);
			if (shape === undefined) throw BoltError.make('bad_answer', 'guest', `Unknown custom output field '${value.of}'.`);
			return { kind: 'custom', name: value.of, value: resolve(shape) };
		}
				const catalog = catalog_of(manifest), model = models[value.of];
				const info = catalog.exposures.get(value.of);
				if (info === undefined) throw BoltError.make('invalid', 'decode', `unknown model '${value.of}'`);
				const identity = (name: string): OutputValueContract => ({ kind: 'identity', model: name });
				const columns: Record<string, OutputField> = {};
				for (const name of default_fields(info, true)) {
					const relation = relationships[`${value.of}.${name}`];
					const declared = model?.fields[name], computed = model?.computed?.[name];
					let member: OutputValueContract;
					if (name === 'id') member = identity(value.of);
					else if (relation !== undefined) {
						member = typeof relation.to === 'string' ? identity(relation.to) : {
							kind: 'union', members: relation.to.map((target): OutputValueContract => ({ kind: 'object', fields: {
								model: { optional: false, value: { kind: 'atom', spec: { kind: 'enum', values: [target] } } },
								id: { optional: false, value: identity(target) }
							} }))
						};
						if (relation.optional === true) member = { kind: 'nullable', value: member };
					} else if (declared !== undefined) member = resolve(declared);
					else if (computed !== undefined) {
						member = computed.kind === 'decimal'
							? resolve({ kind: 'decimal', scale: computed.scale ?? 0 }) : resolve({ kind: computed.kind });
						if (model === undefined || nullable_of_expr(computed.expr, model)) member = { kind: 'nullable', value: member };
					} else if (name === 'revision') member = resolve({ kind: 'int' });
					else if (name === 'created_at' || name === 'updated_at') member = resolve({ kind: 'instant' });
					else if (name === 'created_by' || name === 'updated_by') member = { kind: 'nullable', value: identity('sys_user') };
					else throw BoltError.make('bad_answer', 'guest', `Unknown output field '${value.of}.${name}'.`);
					// A declared Row is complete, including heavy fields; optional values are still present as null.
					columns[name] = { optional: false, value: member };
				}
		return { kind: 'row', model: value.of, fields: columns };
	});
}

/** The server and the browser compile the very same resolved source contract. */
export const output_schema = (manifest: EngineManifest, output: OutputKind | undefined): Schema.Decoder<Wired> =>
	output_value(output_contract(manifest, output));

export const decodeOutput = (manifest: EngineManifest, output: OutputKind | undefined, value: Json): Effect.Effect<Json, BoltError> =>
	Effect.try({
		try: () => output_schema(manifest, output),
		catch: (error) => error instanceof BoltError ? error : BoltError.make('bad_answer', 'guest', String(error), error)
	}).pipe(
		Effect.flatMap((codec) => Schema.decodeUnknownEffect(codec)(value)),
		Effect.map(encode_wire),
		Effect.mapError((error) => error instanceof BoltError ? error : BoltError.make('bad_answer', 'guest', error.message, error))
	);
