import { Option, Result, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Pred, ReadIR, SelectIR } from '../../protocol/ir-types.ts';
import { BoltError } from '../../protocol/errors.ts';

const Spec = Schema.Record(Schema.String, Schema.Json);
/** Guest crossings and native /q groups share the same member scope and dependency validation. */
export function lowerKeyedMember(
	method: string,
	key: string,
	spec: Json,
	read: (method: string, args: readonly Json[]) => ReadIR,
	scope: string | number,
	earlier: ReadonlySet<string>
): ReadIR {
	const lowered = Result.try({
		try: (): ReadIR => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
				throw BoltError.make(
					'invalid',
					'decode',
					'a keyed read member key is a name (letters, digits, _)'
				);
			const decoded = Schema.decodeUnknownOption(Spec)(spec);
			if (Option.isNone(decoded))
				throw BoltError.make('invalid', 'decode', 'a keyed read member is an object');
			const { collection, id, ...query } = decoded.value;
			if (typeof collection !== 'string')
				throw BoltError.make('invalid', 'decode', 'a keyed read member names its collection');
			if (id !== undefined && typeof id !== 'string')
				throw BoltError.make('invalid', 'decode', 'a keyed read member id is a string');
			const ir =
				id === undefined
					? read(method, [collection, query])
					: read(method.replace('read', 'get'), [collection, id, query]);
			if (ir.kind !== 'read' && ir.kind !== 'get')
				throw BoltError.make('invalid', 'decode', 'a keyed read member is a read or get');
			const scoped = (pred: Pred): Pred => {
				switch (pred.t) {
					case 'and':
					case 'or':
						return { ...pred, of: pred.of.map(scoped) };
					case 'not':
						return { ...pred, of: scoped(pred.of) };
					case 'one':
					case 'many':
						return { ...pred, pred: scoped(pred.pred) };
					case 'in':
						if (!Array.isArray(pred.args) && 'member' in pred.args) {
							if (!earlier.has(pred.args.member))
								throw BoltError.make(
									'invalid',
									'decode',
									`'${pred.args.member}' is no earlier member of this read`
								);
							return { ...pred, args: { ...pred.args, member: `${scope}:${pred.args.member}` } };
						}
						return pred;
					default:
						return pred;
				}
			};
			const arms = (select: SelectIR): SelectIR => ({
				...select,
				relations: Object.fromEntries(
					Object.entries(select.relations).map(([relation, value]) => [
						relation,
						{
							...value,
							select: arms(value.select),
							...(value.where === undefined ? {} : { where: scoped(value.where) })
						}
					])
				)
			});
			return {
				...ir,
				...(ir.kind === 'read' && ir.where !== undefined ? { where: scoped(ir.where) } : {}),
				select: arms(ir.select),
				member: key,
				cte: `${scope}:${key}`
			};
		},
		catch: (error) =>
			BoltError.make(
				error instanceof BoltError ? error.code : 'invalid',
				error instanceof BoltError ? error.phase : 'decode',
				`member '${key}': ${error instanceof Error ? error.message : String(error)}`,
				error
			)
	});
	if (Result.isFailure(lowered)) throw lowered.failure;
	return lowered.success;
}
