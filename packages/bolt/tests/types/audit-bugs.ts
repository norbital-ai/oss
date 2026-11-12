// Type-level reproductions for Bolt audit bugs 25, 40 and 41, checked by the suite's `tsgo -p tests/tsconfig.json`.
import type { Actor } from '../../src/decl/access/actor.ts';
import type { EngineActor } from '../../src/engine/contracts.ts';
import type { OutboundShape } from '../../src/engine/services.ts';
import type { Effect } from 'effect';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

// bug 25: a delivery report records; it promises no outcome it never returns
is<Eq<Effect.Success<ReturnType<OutboundShape['delivered']>>, void>>();

// bug 40: each of these names means one shape, exported from one module
// @ts-expect-error `ImageFacts` is the facilities' type alone
export type ContractImageFacts = import('../../src/engine/contracts.ts').ImageFacts;
// @ts-expect-error `NoticeRow` is the protocol's row alone
export type ContractNoticeRow = import('../../src/engine/contracts.ts').NoticeRow;
// @ts-expect-error `ConvertOptions` is the facilities' type alone
export type PortConvertOptions = import('../../src/engine/ports.ts').ConvertOptions;
// @ts-expect-error `Callable` is the authoring context's type alone
export type ServiceCallable = import('../../src/engine/services.ts').Callable;

// bug 41: the author-facing actor carries every field the runtime actor does, kind by kind
type Missing<K> = K extends EngineActor['kind']
	? Exclude<keyof Extract<EngineActor, { kind: K }>, keyof Extract<Actor, { kind: K }>>
	: never;
is<Eq<Missing<EngineActor['kind']>, never>>();
