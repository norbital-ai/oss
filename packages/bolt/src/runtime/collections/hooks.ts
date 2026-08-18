import type { Schema } from 'effect';

export type MutationHook = (
	record: Readonly<Record<string, Schema.Json>>
) => Readonly<Record<string, Schema.Json>>;
/** Owns run hooks behavior at the collections boundary so validation and typed semantics stay consistent for every caller. */
const CollectionHooks = {
	run: (record: Readonly<Record<string, Schema.Json>>, hooks: ReadonlyArray<MutationHook>) =>
		hooks.reduce((current, hook) => hook(current), record)
};
export const runHooks = CollectionHooks.run;
