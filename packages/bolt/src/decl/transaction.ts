import type { Decimal } from '@norbital-ai/std/decimal';
import type {
	ActInput,
	ActOutput,
	Callable,
	Committed,
	Eff,
	PendingApproval,
	ReadAnswer,
	ReadRequest,
	ReadRequestBase
} from './ctx.ts';
import type { ActConflict, ActRefused, ActUnknown } from './errors.ts';
import type { Is } from './names.ts';

/** Internal instruction identity; transaction callbacks cannot yield ordinary Effects. */
export const txInstruction = Symbol('@norbital-ai/bolt/transaction');

/** One native transaction operation, consumed only by its owning transaction. */
export interface TxInstruction {
	readonly [txInstruction]: true;
	readonly member: 'query' | 'act';
	readonly args: readonly unknown[];
}

/** A transaction operation is yielded with `yield*`; its answer is provisional until the outer result commits. */
export interface TxStep<out A> {
	[Symbol.iterator](): Iterator<TxInstruction, A, unknown>;
}

type TxCallable = Extract<Callable, `${string}.${'create' | 'update' | 'upsert' | 'delete'}`>;
type TxOptions<N> = N extends `${string}.upsert`
	? [
			options: {
				onConflict: 'update' | 'keep';
				observed?: never;
				key?: never;
				once?: never;
			}
		]
	: [];

/** A staged write's generated output and row identities; it makes no claim that the transaction has committed. */
export type TxApplied<N extends string> = Pick<Committed<ActOutput<N>, N>, 'output' | 'records'>;

/** Native guarded CRUD inside a transaction; observations and idempotency belong to the session. */
export interface TxAct {
	<const N extends string>(
		callable: Is<N, TxCallable>,
		input: NoInfer<ActInput<N>>,
		...options: NoInfer<TxOptions<N>>
	): TxStep<TxApplied<N>>;
}

/** Caller-scoped model reads and guarded writes on the same native session, including its earlier writes. */
export interface TxCtx {
	/** A read request (roots and their declared layers) on the same session, under the caller's authority; no `asOf`. */
	query<const R extends ReadRequestBase>(
		request: ReadRequest<R> & { readonly [K in keyof R]: { readonly asOf?: never } }
	): TxStep<ReadAnswer<R>>;
	readonly act: TxAct;
}

type TxData<T> = T extends Decimal
	? Exclude<keyof T, keyof Decimal> extends never
		? T
		: never
	: T extends string | number | boolean | null
		? T
		: T extends
					| PromiseLike<unknown>
					| ((...args: never[]) => unknown)
					| (abstract new (...args: never[]) => unknown)
			? never
			: T extends readonly unknown[]
				? undefined extends T[number]
					? never
					: { readonly [K in keyof T]: TxData<T[K]> }
				: T extends object
					? { readonly [K in keyof T]: TxData<T[K]> }
					: never;

/** A callback's native return shape, or top-level void; unsupported values are rejected recursively. */
export type TxValue<T> = T extends void ? T : TxData<T>;

type TxBody<R> = (tx: TxCtx) => Generator<TxInstruction, R, unknown>;

/** A fixed five-second native transaction: only its outer answer can be committed or held for approval. */
export interface Transaction {
	<R>(
		body: TxBody<R> & NoInfer<TxBody<TxValue<R>>>
	): Eff<Committed<R> | PendingApproval, ActRefused | ActConflict | ActUnknown>;
}
