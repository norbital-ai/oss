// Atomic maps correlate statically known results; dynamic maps retain native schema validation.
import { expectTypeOf } from '@effect/vitest';
import type { Effect } from 'effect';
import type { Act, Committed, PendingApproval } from '../../src/decl/ctx.ts';
import type { ActConflict, ActRefused, ActUnknown } from '../../src/decl/errors.ts';
import type { Row } from '../../src/index.ts';
import type { Json } from '../../src/decl/values.ts';
import './registry.ts';

declare const act: Act;
declare const target: Row<'orders'>;
declare const dynamic: Readonly<Record<string, Json>>;
const checked = act(dynamic);
expectTypeOf<Effect.Success<typeof checked>>().toEqualTypeOf<
	Committed<Readonly<Record<string, Json>>> | PendingApproval
>();
expectTypeOf<Effect.Error<typeof checked>>().toEqualTypeOf<ActRefused | ActConflict | ActUnknown>();
declare const result: Effect.Success<typeof checked>;
// @ts-expect-error a held batch has no committed output
void result.output;
if (result.kind === 'committed') expectTypeOf(result.output).toEqualTypeOf<Readonly<Record<string, Json>>>();
const correlated = act({ 'orders.delete': [{ target }] });
expectTypeOf<Effect.Success<typeof correlated>>().toEqualTypeOf<
	Committed<{ readonly 'orders.delete': null }> | PendingApproval
>();
act({ 'orders.update': [{ target, set: { note: 'checked' } }] }, { key: 'save-order' });
// @ts-expect-error delete requires a selected row
act({ 'orders.delete': [{}] });
// @ts-expect-error string ids carry no observed revision
act({ 'orders.delete': [{ target: target.id }] });
// @ts-expect-error every callable is current and declared
act({ 'orders.upsert': [{ id: target.id, note: 'retired' }] });
// @ts-expect-error observations come from each selected row
act({ 'orders.delete': [{ target }] }, { observed: { [target.id]: 1 } });
// @ts-expect-error import conflict policy belongs to the import input
act({ 'orders.delete': [{ target }] }, { on_conflict: 'keep' });
// @ts-expect-error no checked facade
act.checked(dynamic);
// @ts-expect-error no many facade
act.many([{ callable: 'orders.delete', input: [{ target }] }]);
// @ts-expect-error a dynamic map must contain JSON
act({ [String(target.id)]: new Date() });
