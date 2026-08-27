import { Effect, Schema } from 'effect';
import type { CollectionFilterOperator } from '#lib/collection-filter/collection-filter-operators';

/** An editable filter row a collection surface opens with. */
export interface CollectionInitialFilter {
	readonly field: string;
	readonly operator: CollectionFilterOperator;
	readonly value?: unknown;
}

export interface CollectionPipelineContext<TRow extends object> {
	readonly collectionName: string;
	readonly selectedRows: readonly TRow[];
}

export interface CollectionPipeline<TRow extends object> {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
	readonly requiresSelection?: boolean;
	readonly getDisabledReason?: (selectedRows: readonly TRow[]) => string | null;
	run(context: CollectionPipelineContext<TRow>): Effect.Effect<unknown, unknown>;
}

const collectionIntegrationStateSchema = Schema.Literals([
	'connected',
	'configured',
	'degraded',
	'error',
	'disabled'
]);
export type CollectionIntegrationState = typeof collectionIntegrationStateSchema.Type;

const collectionIntegrationStatusSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	description: Schema.optionalKey(Schema.String),
	state: collectionIntegrationStateSchema,
	statusLabel: Schema.optionalKey(Schema.String)
});
export type CollectionIntegrationStatus = typeof collectionIntegrationStatusSchema.Type;
