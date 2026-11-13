import assert from 'node:assert/strict';
import { Schema } from 'effect';
import type { ActBody, Outcome as WireOutcome, SyncControlBody } from '../../bolt/build/protocol/schema.js';
import type { Json } from '@norbital-ai/store/wire';

/** These controls submit one operation; assert the native envelope before inspecting its values. */
export const single_act = (body: ActBody): {
	callable: string;
	input: Json;
	observed?: Readonly<Record<string, number>>;
} => {
	if ('callable' in body) return {
		callable: body.callable,
		input: body.input,
		...(body.observed === undefined ? {} : { observed: body.observed })
	};
	const entries = Object.entries(body.acts);
	assert.equal(entries.length, 1);
	const entry = entries[0];
	assert.ok(entry);
	return { callable: entry[0], input: entry[1] };
};
export type SentAct = ReturnType<typeof single_act> & { readonly key: string };
const RunInput = Schema.Struct({ automation: Schema.String, runs: Schema.Array(Schema.Struct({ id: Schema.String })) });
/** A job admission's receipt: the requested run ids under their automation. */
const receipt = (automation: string, ids: readonly string[]) => ({ id: ids[0] ?? null, ids, automation });
/**
 * A committed act as the host answers it: a generated write keys each requested callable to its output (null), a run
 * admission returns its receipt, any other command null.
 */
export const committed = (body: ActBody): WireOutcome => {
	if ('acts' in body)
		return { kind: 'committed', output: Object.fromEntries(Object.keys(body.acts).map((callable) => [callable, null])), records: [] };
	if (body.callable !== 'run') return { kind: 'committed', output: null, records: [] };
	const { automation, runs } = Schema.decodeUnknownSync(RunInput)(body.input);
	return { kind: 'committed', output: receipt(automation, runs.map((run) => run.id)), records: [] };
};
/** A committed sync control: its one run's receipt. */
export const admitted = (body: SyncControlBody): WireOutcome => ({
	kind: 'committed',
	output: receipt(`${body.model}.sync.${body.sync}`, [body.id]),
	records: []
});
