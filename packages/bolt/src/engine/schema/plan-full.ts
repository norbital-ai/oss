// Full schema planner (pulls store's multilingual search table; kept out of cell runtime imports).
import { Effect } from 'effect';
import { plan as storePlan, type Plan } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import {
	engineBeside,
	fingerprint,
	schema_slice,
	type AppliedSchemaSlice,
	type SchemaSlice
} from './plan.ts';

/** The store's plan from `applied` to the manifest's (or a given) slice, the engine's objects beside both. */
export const plan = (
	applied: AppliedSchemaSlice | null,
	next: EngineManifest | SchemaSlice
): Effect.Effect<Plan & { readonly slice: SchemaSlice }, BoltError> => {
	const slice = 'workspace' in next ? schema_slice(next) : next;
	return storePlan(applied?.schema ?? null, slice, engineBeside).pipe(
		Effect.map((p) => ({
			...p,
			from: applied?.fingerprint ?? null,
			to: fingerprint(slice),
			slice
		})),
		Effect.catchTag('StoreError', (e) => Effect.fail(from_store(e)))
	);
};
