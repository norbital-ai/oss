// The `__verify` line (§3.3.9, X-12). What a model literal cannot see, because it lives in `+relationship.ts` or in
// another model, is checked once over the whole names index: `.norbital/names.ts` ends with
// `export const __verify: Check<Verify> = true;`, which fails tsc with every message below.
import type { Columns, DuplicateInverse, FieldName, ManyRels, NamesPart, OneRels, OwnedInverse } from './names.ts';

type Models = NamesPart<'models'>;
type Listed<X> = X extends readonly (infer E)[] ? Listed<E> : X;
type Each<X, K extends string> = X extends readonly (infer E)[] ? E extends { [P in K]: infer V } ? Listed<V> : never : never;
type WhereKeys<W> = W extends object ? Exclude<keyof W, 'and' | 'or' | 'not'>
	| (W extends { and: readonly (infer A)[] } ? WhereKeys<A> : never) | (W extends { or: readonly (infer A)[] } ? WhereKeys<A> : never)
	| (W extends { not: infer A } ? WhereKeys<A> : never) : never;
type Unknown<M, Names, Allowed, Where extends string> = Exclude<Names, Allowed> extends infer X
	? X extends string ? `${M & string}: ${Where} names unknown field '${X}'` : never : never;
type Numeric = { kind: 'int' | 'decimal' | 'money' | 'sum' | 'count' };
type ChildNames<C> = keyof Columns<C> | keyof OneRels<C>;

type RollUp<M, P extends string, K> =
	K extends { kind: 'sum'; of: `${infer R}.${infer F}` } ? R extends keyof ManyRels<M>
		? F extends keyof Columns<ManyRels<M>[R]> ? Columns<ManyRels<M>[R]>[F] extends Numeric
			? Unknown<M, WhereKeys<K extends { where: infer W } ? W : never>, ChildNames<ManyRels<M>[R]>, `${P}.where`>
			: `${M & string}: ${P} sums '${F}', which is not a number` : `${M & string}: ${P} sums unknown field '${F}'`
		: `${M & string}: ${P} follows '${R}', which is not a relationship back to ${M & string}`
	: K extends { kind: 'count'; of: infer R } ? R extends keyof ManyRels<M>
		? Unknown<M, WhereKeys<K extends { where: infer W } ? W : never>, ChildNames<ManyRels<M>[R]>, `${P}.where`>
		: `${M & string}: ${P} counts '${R & string}', which is not a relationship back to ${M & string}`
	: K extends { kind: 'state'; states: infer S } ? Unknown<M, { [X in keyof S]: S[X] extends { edit: readonly (infer E)[] } ? E : never }[keyof S],
		FieldName<M> | OwnedInverse<M>, `${P}.edit`>
	: K extends { kind: 'seq'; per: infer L } ? Unknown<M, Listed<L>, FieldName<M>, `${P}.per`>
	: never;

type ModelErrors<M, D = Models[M & keyof Models]> =
	| Unknown<M, Listed<D extends { label: infer L } ? L : never>, FieldName<M>, 'label'>
	| Unknown<M, Listed<D extends { key: infer L } ? L : never>, FieldName<M>, 'key'>
	| Unknown<M, Each<D extends { unique: infer L } ? L : never, 'fields'>, FieldName<M>, 'unique'>
	| Unknown<M, Listed<D extends { index: infer L } ? L : never>, FieldName<M>, 'index'>
	| Unknown<M, Each<D extends { noOverlap: infer L } ? L : never, 'key'>, FieldName<M>, 'noOverlap'>
	| Unknown<M, D extends { check: infer C } ? { [N in keyof C]: WhereKeys<C[N] extends { where: infer W; message: string } ? W : C[N]> }[keyof C] : never, keyof Columns<M> | keyof OneRels<M>, 'check'>
	| (DuplicateInverse<M> extends infer I extends string ? I extends unknown ? `${M & string}: inverse '${I}' is declared twice` : never : never)
	| (D extends { fields: infer F } ? { [P in keyof F & string]: RollUp<M, P, F[P]> }[keyof F & string] : never);

/** Locale keys the base catalogue lacks, as messages. */
export type LocaleErrors<Locales = NamesPart<'locales'>, Base = NamesPart<'messages'>> = { [L in keyof Locales & string]:
	Exclude<keyof Locales[L], keyof Base> extends infer K ? K extends string ? `i18n: +${L}.messages.ts key '${K}' is not in +messages.ts` : never : never
}[keyof Locales & string];

/** Every cross-file declaration error in the workspace, as messages; `never` when there is none. */
export type Verify = { [M in keyof Models & string]: ModelErrors<M> }[keyof Models & string] | LocaleErrors;
/**
 * `true` when `E` is `never`; otherwise an object type whose keys are the error messages, so tsc prints them. The generated `Check<Verify>` gate.
 */
export type Check<E> = [E] extends [never] ? true : { [K in E & string]: K }[E & string];   // `true` fails; tsc prints the messages
