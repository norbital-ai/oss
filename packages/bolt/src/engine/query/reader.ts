// Who reads, as the store's read compiler takes it (A4): a caller's Authority as the store's `Scope` — its read arms per
// output and path conjoined at every level (rule 13), and the open approval request a root row of a holdable model
// carries (rule 46b), for every reader — and the invocation's bindings as the operand resolver. A workspace read (the transform, rule 15) has no scope. Statements a batch may fold into one are marked here.
import { Effect } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import {
	StoreError,
	type CompileOptions,
	type Operand,
	type Scope,
	type Sql
} from '@norbital-ai/store';
import type { Authority, Bindings, Reader } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { operand } from './eval.ts';

/** Fixed clock operands for one invocation; the owner chooses when its clock is read. */
export function bindingsAt(at: number | string, tz: string): Bindings {
	return {
		now: typeof at === 'string' ? at : new Date(at).toISOString(),
		today: localOf(typeof at === 'number' ? at : Date.parse(at), tz).date,
		tz
	};
}

const rootOf = (path: string) => path.split('.', 1)[0]!;
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
/** A caller's scope: none for an admin's rows. */
export function scopeOf(authority: Authority): Scope {
	return {
		// a layer path is scoped by its root's arms for that output and path (decision 3), never its own model's grants
		rows: (path, output) =>
			authority.admin
				? undefined
				: (authority.models[rootOf(path)]?.read[output]?.[path] ?? []).map((arm) => arm.where)
	};
}
/** A caller's scope over every output it holds: a row any granted output's arms admit (a write's read visibility). */
export function anyOutputScope(authority: Authority): Scope {
	return {
		rows: (path) =>
			authority.admin
				? undefined
				: Object.values(authority.models[rootOf(path)]?.read ?? {})
						.flatMap((paths) => paths[path] ?? [])
						.map((arm) => arm.where)
	};
}
/** The open request holding a root row of a held model, as `$approval`: every reader sees it, scoped or not. */
export const heldColumns =
	(approvals: ReadonlySet<string>) =>
	(c: string, a: string): readonly string[] =>
		approvals.has(c)
			? [
					`(SELECT jsonb_build_object('requestId', ap.id::text, 'state', ap.state, 'step', ap.step,
		'steps', ap.route -> 'steps', 'by', coalesce(apu.name, apu.email, ap.requestor))
	FROM bolt_approvals ap LEFT JOIN sys_user apu ON apu.id::text = ap.requestor_user
	WHERE ap.state IN ('Pending', 'ChangesRequested')
		AND ap.records @> jsonb_build_array(jsonb_build_object('collection', ${lit(c)}::text, 'id', ${a}."id"::text))
	ORDER BY ap.seq DESC LIMIT 1) AS "$approval"`
				]
			: [];
/** The invocation's requestor variables (`{ var: 'requestor.…' }`), fixed per invocation (rule 26). */
export const resolverOf =
	(bindings: Bindings, authority: Authority | null) =>
	(o: Operand): Effect.Effect<Json, StoreError> =>
		Effect.try({
			try: () => operand(o, bindings, authority),
			catch: (e) =>
				StoreError.of('invalid', 'decode', e instanceof BoltError ? e.message : String(e))
		});
/** The compile options of one read by `reader` at `bindings`. */
export function readOptions(
	reader: Reader,
	bindings: Bindings,
	options: {
		readonly sources?: ReadonlyMap<string, string> | undefined;
		readonly approvals?: ReadonlySet<string> | undefined;
		readonly allBytes?: number | undefined;
	} = {}
): CompileOptions {
	const authority = reader.as === 'caller' ? reader.authority : null;
	return {
		...(authority === null ? {} : { scope: scopeOf(authority) }),
		...(options.approvals === undefined ? {} : { root: heldColumns(options.approvals) }),
		resolve: resolverOf(bindings, authority),
		tz: bindings.tz,
		sources: options.sources,
		allBytes: options.allBytes
	};
}

const composableStatements = new WeakSet<Sql>();
/** Mark a compiled read as safe to fold into the batch's SQL statement. */
export const composable = <S extends Sql>(statement: S): S => {
	composableStatements.add(statement);
	return statement;
};
export const isComposable = (statement: Sql): boolean => composableStatements.has(statement);
