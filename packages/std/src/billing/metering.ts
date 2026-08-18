/**
 * The catalogue of what Colony actually meters, and nothing else.
 *
 * The workspace Studio shows exactly four meters — compute in active seconds, database and files in
 * GB-hours, and AI in provider-reported USD — and these are the only sources a tenant bill or the
 * operator ledger may name. Every source is billable: the host reports a measured value per
 * tenant, so there is no shared-overhead or unbilled entry here.
 */
export const BILLING_SOURCE_IDS = ['compute', 'database', 'files', 'ai'] as const;

export type BillingSourceId = (typeof BILLING_SOURCE_IDS)[number];

export type BillingSourceDefinition = {
	label: string;
	placement: 'bare_metal' | 'external';
	billable: true;
	description: string;
};

/**
 * Human-readable, versioned catalogue for every resource source a tenant sees.
 *
 * A source is never silently charged: each of these is attributed directly to the tenant whose
 * meter produced the observation, and the units below are the units the Studio displays.
 */
export const BILLING_SOURCE_CATALOGUE = {
	compute: {
		label: 'Compute',
		placement: 'bare_metal',
		billable: true,
		description:
			'Isolate wall-clock seconds. RAM is included: the isolate hard-walls memory with the same second.'
	},
	database: {
		label: 'Disc',
		placement: 'external',
		billable: true,
		description: 'Tenant PostgreSQL storage, metered as GB-hours.'
	},
	files: {
		label: 'Files',
		placement: 'external',
		billable: true,
		description: 'Tenant file storage, metered as GB-hours.'
	},
	ai: {
		label: 'AI',
		placement: 'external',
		billable: true,
		description: 'Provider-reported model usage cost, metered as provider USD.'
	}
} as const satisfies Record<BillingSourceId, BillingSourceDefinition>;

/** The unit each meter is reported and displayed in. */
export const BILLING_SOURCE_UNITS = {
	compute: 'active seconds',
	database: 'GB-hours',
	files: 'GB-hours',
	ai: 'provider USD'
} as const satisfies Record<BillingSourceId, string>;
