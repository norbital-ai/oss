// Declared operation results have one resolved wire contract on the server and in the browser.
// This graph contains only decoding information: row/custom references have already been resolved by their owner.
import { Schema, SchemaGetter } from 'effect';
import { input_schema, KindSchema, type Kind, type KindCodec, type OutputKind, type Value } from '@norbital-ai/store/kind';
import type { Json } from '@norbital-ai/store/wire';
import { ProtocolFailed } from '../decl/errors.ts';
import { RowStateFields } from './record-contracts.ts';

export type OutputField = { readonly optional: boolean; readonly value: OutputValueContract };
export type OutputValueContract =
	| { readonly kind: 'atom'; readonly spec: Kind }
	| { readonly kind: 'identity'; readonly model: string }
	| { readonly kind: 'row'; readonly model: string; readonly fields: Readonly<Record<string, OutputField>> }
	| { readonly kind: 'custom'; readonly name: string; readonly value: OutputValueContract }
	| { readonly kind: 'array'; readonly item: OutputValueContract; readonly min_items?: number; readonly max_items?: number }
	| { readonly kind: 'nullable'; readonly value: OutputValueContract }
	| { readonly kind: 'object'; readonly fields: Readonly<Record<string, OutputField>>; readonly rest?: OutputValueContract }
	| { readonly kind: 'record'; readonly value: OutputValueContract }
	| { readonly kind: 'union'; readonly members: readonly OutputValueContract[] };
export type OutputContract = { readonly kind: 'void' } | OutputValueContract;
type OutputResolver = (
	reference: Extract<OutputKind, { kind: 'row' | 'custom' }>,
	resolve: (kind: OutputKind) => OutputValueContract
) => OutputValueContract;

const flags = (kind: Kind) => ({
	...(kind.many === undefined ? {} : { many: kind.many }),
	...(kind.optional === undefined ? {} : { optional: kind.optional }),
	...(kind.min_items === undefined ? {} : { min_items: kind.min_items }),
	...(kind.max_items === undefined ? {} : { max_items: kind.max_items })
});
/** Metadata retains native scalar validation, never defaults, labels, migration/workflow data or predicates. */
function atom(kind: Kind): OutputValueContract {
	const { default: _default, was: _was, key: _key, label: _label, help: _help, hidden: _hidden, ...plain } = kind;
	switch (plain.kind) {
		case 'sum': return { kind: 'atom', spec: { kind: 'decimal', scale: 0, ...flags(plain) } };
		case 'count': return { kind: 'atom', spec: { kind: 'int', min: 0, ...flags(plain) } };
		case 'state': return { kind: 'atom', spec: { kind: 'enum', values: Object.keys(plain.states), ...flags(plain) } };
		case 'seq': return { kind: 'atom', spec: plain.pattern === undefined
			? { kind: 'int', ...flags(plain) } : { kind: 'text', ...flags(plain) } };
		case 'enum': {
			const { transitions: _transitions, ...value } = plain;
			return { kind: 'atom', spec: value };
		}
		case 'ref': throw new ProtocolFailed({ message: 'Reference output must retain its source identity.' });
		default: return { kind: 'atom', spec: plain };
	}
}
const unresolved: OutputResolver = (reference) => {
	throw new ProtocolFailed({ message: `Unresolved ${reference.kind} output '${reference.of}'.` });
};
/** The one structural output walk, shared by manifest resolution and already-resolved browser field kinds. */
export function kind_output(output: OutputKind, reference: OutputResolver = unresolved): OutputValueContract {
	const visit = (value: OutputKind, seen: ReadonlySet<string>): OutputValueContract => {
		const fields = (members: Readonly<Record<string, OutputKind>>) => {
			const result: Record<string, OutputField> = {};
			for (const [name, member] of Object.entries(members)) result[name] = {
				optional: member.optional === true || member.default !== undefined, value: visit(member, seen)
			};
			return result;
		};
		let result: OutputValueContract;
		switch (value.kind) {
			case 'row':
			case 'custom': {
				const key = `${value.kind}:${value.of}`;
				if (seen.has(key)) throw new ProtocolFailed({ message: `Recursive output reference '${key}'.` });
				result = reference(value, (member) => visit(member, new Set([...seen, key])));
				break;
			}
			case 'ref': result = typeof value.to === 'string' ? { kind: 'identity', model: value.to }
				: { kind: 'union', members: value.to.map((model): OutputValueContract => ({ kind: 'object', fields: {
					model: { optional: false, value: { kind: 'atom', spec: { kind: 'enum', values: [model] } } },
					id: { optional: false, value: { kind: 'identity', model } }
				} })) }; break;
			case 'json': result = value.shape === undefined ? atom({ kind: 'json' }) : visit(value.shape, seen); break;
			case 'record': result = { kind: 'record', value: visit(value.of, seen) }; break;
			case 'object': result = { kind: 'object', fields: fields(value.fields), ...(value.rest === undefined ? {} : { rest: visit(value.rest, seen) }) }; break;
			case 'union': result = { kind: 'union', members: 'of' in value ? value.of.map((arm) => visit(arm, seen))
				: Object.entries(value.arms).map(([tag, members]): OutputValueContract => ({ kind: 'object', fields: {
					...fields(members), [value.by]: { optional: false, value: { kind: 'atom', spec: { kind: 'enum', values: [tag] } } }
				} })) }; break;
			default: return atom(value);
		}
		if (value.many === true) result = { kind: 'array', item: result,
			...(value.min_items === undefined ? {} : { min_items: value.min_items }),
			...(value.max_items === undefined ? {} : { max_items: value.max_items }) };
		return value.optional === true ? { kind: 'nullable', value: result } : result;
	};
	return visit(output, new Set());
}

const Atom = KindSchema.check(Schema.makeFilter((kind) =>
	!['row', 'custom', 'object', 'record', 'union', 'ref'].includes(kind.kind) &&
	(kind.kind !== 'json' || kind.shape === undefined) || 'An output atom must be fully resolved.'
));
const ValueContractSchema: Schema.Codec<OutputValueContract, Json> = Schema.suspend(() => Schema.Union([
	Schema.Struct({ kind: Schema.Literal('atom'), spec: Atom }),
	Schema.Struct({ kind: Schema.Literal('identity'), model: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('row'), model: Schema.String, fields: Schema.Record(Schema.String, Schema.Struct({
		optional: Schema.Boolean, value: ValueContractSchema
	})) }),
	Schema.Struct({ kind: Schema.Literal('custom'), name: Schema.String, value: ValueContractSchema }),
	Schema.Struct({ kind: Schema.Literal('array'), item: ValueContractSchema,
		min_items: Schema.optionalKey(Schema.Number), max_items: Schema.optionalKey(Schema.Number) }),
	Schema.Struct({ kind: Schema.Literal('nullable'), value: ValueContractSchema }),
	Schema.Struct({ kind: Schema.Literal('object'), fields: Schema.Record(Schema.String, Schema.Struct({
		optional: Schema.Boolean, value: ValueContractSchema
	})), rest: Schema.optionalKey(ValueContractSchema) }),
	Schema.Struct({ kind: Schema.Literal('record'), value: ValueContractSchema }),
	Schema.Struct({ kind: Schema.Literal('union'), members: Schema.Array(ValueContractSchema) })
]));
const OutputContractSchema: Schema.Codec<OutputContract, Json> = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('void') }), ValueContractSchema
]);
/** Authorized automation results are independent of the viewer's model read grants. */
export const OperationOutputs = Schema.Struct({
	automations: Schema.Record(Schema.String, Schema.Struct({
		mode: Schema.Literals(['job', 'call']), output: OutputContractSchema
	}))
});
export type OperationOutputs = typeof OperationOutputs.Type;

const VoidOutput = Schema.Null.pipe(Schema.decodeTo(Schema.Undefined, {
	decode: SchemaGetter.transform(() => undefined),
	encode: SchemaGetter.transform(() => null)
}));
const output_fields = (declared: Readonly<Record<string, OutputField>>) => {
	const fields: Record<string, KindCodec | Schema.optionalKey<KindCodec>> = {};
	for (const [name, field] of Object.entries(declared)) {
		const value = value_output(field.value);
		fields[name] = field.optional ? Schema.optionalKey(value) : value;
	}
	return fields;
};
/** Compile the exact resolved source contract; unshaped JSON keeps literal `$dec` objects as JSON. */
function value_output(contract: OutputValueContract): KindCodec {
	switch (contract.kind) {
		case 'atom': return input_schema(contract.spec);
		case 'identity': return Schema.NonEmptyString;
		case 'row': return Schema.Struct({ ...output_fields(contract.fields), ...RowStateFields });
		case 'custom': return value_output(contract.value);
		case 'array': return Schema.Array(value_output(contract.item)).check(Schema.makeFilter((items) =>
			(contract.min_items === undefined || items.length >= contract.min_items) &&
			(contract.max_items === undefined || items.length <= contract.max_items) || 'The result has the wrong number of items.'
		));
		case 'nullable': return Schema.NullOr(value_output(contract.value));
		case 'record': return Schema.Record(Schema.String, value_output(contract.value));
		case 'union': return Schema.Union(contract.members.map(value_output));
		case 'object': {
			const named = Schema.Struct(output_fields(contract.fields));
			return contract.rest === undefined ? named : Schema.StructWithRest(named, [
				Schema.Record(Schema.String, value_output(contract.rest))
			]);
		}
	}
}
export const output_value = (contract: OutputContract): Schema.Decoder<Value | undefined> =>
	contract.kind === 'void' ? VoidOutput : value_output(contract);
/** Resolved read/UI kinds use exact output object-presence semantics, with native scalar codecs unchanged. */
export const kind_value = (kind: Kind): KindCodec => value_output(kind_output(kind));
/** Select only the named granted call's own result contract; no caller-selected result type is accepted. */
export function call_output(catalog: OperationOutputs, automation: string): Schema.Decoder<Value | undefined> {
	const entry = Object.hasOwn(catalog.automations, automation) ? catalog.automations[automation] : undefined;
	if (entry === undefined || entry.mode !== 'call')
		throw new ProtocolFailed({ message: `No declared call output is available for '${automation}'.` });
	return output_value(entry.output);
}

const ImportReportSchema = Schema.Struct({ rows: Schema.Array(Schema.Struct({
	index: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	id: Schema.NullOr(Schema.String),
	action: Schema.Literals(['created', 'updated', 'kept', 'skipped', 'deleted'])
})) });
export type ImportReport = typeof ImportReportSchema.Type;
/** Generated writes return exactly the requested callable keys: null, or their native import report. */
export function act_output(acts: Readonly<Record<string, unknown>>) {
	const fields: Record<string, Schema.Decoder<null | ImportReport>> = {};
	for (const name of Object.keys(acts)) {
		const at = name.lastIndexOf('.'), verb = name.slice(at + 1);
		if (at < 1 || !['create', 'update', 'delete', 'erase', 'import'].includes(verb))
			throw new ProtocolFailed({ message: `No generated write output is defined for '${name}'.` });
		fields[name] = verb === 'import' ? ImportReportSchema : Schema.Null;
	}
	return Schema.Struct(fields);
}
/** A job admission acknowledges exactly the locally allocated run ids and requested automation name. */
export function job_receipt(automation: string, ids: readonly string[]) {
	const first = ids[0];
	if (first === undefined) throw new ProtocolFailed({ message: 'A job admission needs at least one run id.' });
	return Schema.Struct({
		id: Schema.Literal(first),
		ids: Schema.Array(Schema.String).check(Schema.makeFilter((received) =>
			received.length === ids.length && received.every((id, index) => id === ids[index]) ||
			'The admitted run ids differ from the requested ids.'
		)),
		automation: Schema.Literal(automation)
	});
}
