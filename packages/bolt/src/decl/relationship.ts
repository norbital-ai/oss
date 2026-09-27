// `relationship()` (§3.3.3): every ref of the workspace in `src/data/+relationship.ts`, keyed '<model>.<fk field>'.
import type { Checked, Exact } from './fields.ts';
import type { ColumnName, ModelName, RelationshipSpec, SystemModelName, TargetName } from './names.ts';
import type { StaticWhere } from './where.ts';

type GrantKey = 'read' | 'history' | 'create' | 'update' | 'delete' | 'queries' | 'actions' | 'moves' | 'via';
type Targets<E> = E extends { to: infer T } ? T extends readonly (infer A)[] ? A : T : never;
// A second inverse of one name on one target is `Verify`'s: a pairwise check here cost O(n²) (G1 scale fixture).
type InverseSpec<R, K, I, T> = I extends GrantKey ? `error: inverse '${I}' is a grant key`
	: T extends TargetName ? I extends ColumnName<T> ? `error: inverse '${I & string}' is already a field of ${T & string}`
		: `${T & string}.${I & string}` extends keyof R ? `error: inverse '${I & string}' is already a ref of ${T & string}`
		: string
	: string;
type EntrySpec<R, K, E, T = Targets<E>> = {
	to: TargetName | readonly [TargetName, TargetName, ...TargetName[]];
	inverse?: E extends { inverse: infer I } ? InverseSpec<R, K, I, T> : string;
	optional?: true;
	default?: { actor: [T] extends ['sys_user'] ? 'id' | 'party' : 'party' };
	// `owned` implies cascade; `setNull` needs an optional ref (rule 4)
	onDelete?: E extends { owned: true } ? 'cascade' : E extends { optional: true } ? 'restrict' | 'cascade' | 'setNull' : 'restrict' | 'cascade';
	owned?: true;
	where?: [T] extends [TargetName] ? StaticWhere<T, false> : never;
};
type RelationshipsFor<R> = {
	[K in keyof R]: K extends `${infer M}.${infer F}`
		// a system model's refs are the built-in layer's (a workspace's are refused: `load/system-owned`)
		? M extends ModelName | SystemModelName ? F extends ColumnName<M> ? `error: '${F}' is already a field of ${M}` : EntrySpec<R, K, R[K]>
			: `error: unknown model '${M}'`
		: 'error: a relationship key is <model>.<field>'
};

type Relationships = { readonly [key: string]: RelationshipSpec };
/**
 * `src/data/+relationship.ts`: every relation, keyed `'<model>.<fk field>'`. Each entry adds an FK field to that model
 * pointing `to` a target model, with an optional `inverse` many-relation on the target; `owned` children are written and
 * deleted with their parent. Returns the literal.
 * @example
 * export default relationship({ 'lines.order': { to: 'orders', inverse: 'lines', owned: true } });
 */
export function relationship<const R extends Relationships>(spec: R & Checked<Relationships, R, Exact<R, RelationshipsFor<R>>>): R {
	return spec;
}
