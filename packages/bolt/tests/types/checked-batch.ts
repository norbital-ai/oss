// Dynamic batches retain native input validation without claiming correlated JSON outputs.
import { expectTypeOf } from '@effect/vitest';
import type { Effect } from 'effect';
import type { Act, Committed, PendingApproval } from '../../src/decl/ctx.ts';
import type { ActConflict, ActRefused, ActUnknown } from '../../src/decl/errors.ts';
import type { Id } from '../../src/index.ts';
import type { Json } from '../../src/decl/values.ts';
import './registry.ts';

declare const act: Act;
declare const id: Id<'orders'>;
const dynamic: Parameters<Act['checked']>[0] = [
	{ callable: 'orders.create', input: [{ fieldsValidatedAtRuntime: true }] },
	{ callable: 'orders.delete', input: [{ target: id }] }
];
const checked = act.checked(dynamic);
expectTypeOf<Effect.Success<typeof checked>>().toEqualTypeOf<
	Committed<readonly Json[]> | PendingApproval
>();
expectTypeOf<Effect.Error<typeof checked>>().toEqualTypeOf<ActRefused | ActConflict | ActUnknown>();
declare const result: Effect.Success<typeof checked>;
// @ts-expect-error a held batch has no committed output
void result.output;
if (result.kind === 'committed') expectTypeOf(result.output).toEqualTypeOf<readonly Json[]>();

const correlated = act.many([{ callable: 'orders.delete', input: [{ target: id }] }]);
expectTypeOf<Effect.Success<typeof correlated>>().toEqualTypeOf<
	Committed<readonly [null]> | PendingApproval
>();
// @ts-expect-error the original correlated API still rejects a malformed delete
act.many([{ callable: 'orders.delete', input: [{}] }]);
// @ts-expect-error dynamic batches admit only generated create/update/upsert/delete
act.checked([{ callable: 'orders.renote', input: {} }]);
// @ts-expect-error imports are outside the batch contract
act.checked([{ callable: 'orders.import', input: {} }]);
// @ts-expect-error erasure is outside the batch contract
act.checked([{ callable: 'orders.erase', input: {} }]);
// @ts-expect-error inputs must be JSON before the native schema validates their shape
act.checked([{ callable: 'orders.delete', input: new Date() }]);

// Observations belong to the individual verb, and a generated upsert always names its conflict policy.
act.many([
	{
		callable: 'orders.upsert',
		input: [{ id, note: 'retained' }],
		onConflict: 'keep',
		observed: { [id]: 1 }
	},
	{
		callable: 'orders.update',
		input: [{ target: id, set: { note: 'checked' } }],
		observed: { [id]: 1 }
	}
]);
act.checked([
	{
		callable: 'orders.upsert',
		input: [{ id, note: 'retained' }],
		onConflict: 'update',
		observed: { [id]: 1 }
	}
]);
// @ts-expect-error correlated upserts require an explicit native conflict policy
// prettier-ignore
act.many([{ callable: 'orders.upsert', input: [{ id, note: 'missing policy' }] }]);
// @ts-expect-error dynamically checked upserts also require an explicit conflict policy
// prettier-ignore
act.checked([{ callable: 'orders.upsert', input: [{ id, note: 'missing policy' }] }]);
// @ts-expect-error correlated observations keep numeric revisions
// prettier-ignore
act.many([{ callable: 'orders.update', input: [{ target: id, set: { note: 'x' } }], observed: { [id]: '1' } }]);
// @ts-expect-error dynamically checked observations keep numeric revisions
// prettier-ignore
act.checked([{ callable: 'orders.delete', input: [{ target: id }], observed: { [id]: '1' } }]);
// @ts-expect-error conflict policies apply only to upserts, never deletes
// prettier-ignore
act.many([{ callable: 'orders.delete', input: [{ target: id }], onConflict: 'keep' }]);
// @ts-expect-error dynamic native creates cannot carry an upsert conflict policy
// prettier-ignore
act.checked([{ callable: 'orders.create', input: [{}], onConflict: 'update' }]);
