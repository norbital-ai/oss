import { Schema } from 'effect';

/** The organization profile read and written by the organization settings surface. */
const OrganizationDraftSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	countryCode: Schema.String,
	companySize: Schema.String,
	logoKey: Schema.NullOr(Schema.String)
});

export type OrganizationDraft = typeof OrganizationDraftSchema.Type;

export const EMPTY_ORGANIZATION_DRAFT: OrganizationDraft = {
	name: '',
	description: '',
	countryCode: '',
	companySize: '',
	logoKey: null
};

/** One observation in the host's metered ledger. */
const MeteredObservationSchema = Schema.Struct({
	kind: Schema.String,
	quantity: Schema.Number,
	observedAtMillis: Schema.Number
});

export type MeteredObservation = typeof MeteredObservationSchema.Type;

const PeriodEstimateMeterSchema = Schema.Struct({
	kind: Schema.String,
	monthToDateQuantity: Schema.Number,
	projectedQuantity: Schema.Number,
	monthToDateMicroSgd: Schema.Number,
	projectedMicroSgd: Schema.Number,
	method: Schema.String
});

/** The host's estimate for the current UTC billing month. */
const PeriodEstimateSchema = Schema.Struct({
	periodStartMillis: Schema.Number,
	periodEndMillis: Schema.Number,
	asOfMillis: Schema.Number,
	meters: Schema.Array(PeriodEstimateMeterSchema),
	monthToDateMicroSgd: Schema.Number,
	projectedMicroSgd: Schema.Number
});

export type PeriodEstimate = typeof PeriodEstimateSchema.Type;

export const EMPTY_PERIOD_ESTIMATE: PeriodEstimate = {
	periodStartMillis: 0,
	periodEndMillis: 0,
	asOfMillis: 0,
	meters: [],
	monthToDateMicroSgd: 0,
	projectedMicroSgd: 0
};

/** The organization-owned portion of the host operations response. */
export const OrganizationHostSnapshotSchema = Schema.Struct({
	organization: OrganizationDraftSchema,
	usage: Schema.Array(MeteredObservationSchema),
	usageEstimate: Schema.NullOr(PeriodEstimateSchema),
	stripeDashboardUrl: Schema.String
});
