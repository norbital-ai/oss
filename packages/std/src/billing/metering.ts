export const BILLING_RESOURCE_TYPES = [
	'cpu',
	'ram',
	'disk_local',
	'disk_neon',
	'disk_r2',
	'ai'
] as const;

export type BillingResourceType = (typeof BILLING_RESOURCE_TYPES)[number];

export const BILLING_ALLOCATION_METHODS = [
	'direct',
	'shared_equal',
	'shared_weighted',
	'platform'
] as const;

export type BillingAllocationMethod = (typeof BILLING_ALLOCATION_METHODS)[number];

export const BILLING_MEASUREMENT_STATUSES = ['measured', 'unavailable'] as const;
export type BillingMeasurementStatus = (typeof BILLING_MEASUREMENT_STATUSES)[number];

export const BILLING_SOURCE_IDS = [
	'tenant_container',
	'core_shared',
	'redis_shared',
	'durable_streams',
	'workspace_source',
	'runtime_files',
	'checkpoint_cache',
	'channel_auth',
	'redis_persistence',
	'tenant_database',
	'system_database',
	'object_storage',
	'lightpanda_capacity',
	'website_capacity',
	'host_platform',
	'openrouter'
] as const;

export type BillingSourceId = (typeof BILLING_SOURCE_IDS)[number];

export type BillingSourceDefinition = {
	label: string;
	placement: 'bare_metal' | 'external';
	allocation: BillingAllocationMethod;
	billable: boolean;
	description: string;
};

/**
 * Human-readable, versioned catalogue for every resource source visible in a
 * tenant bill or the operator ledger. A source is never silently charged: if
 * direct attribution is unavailable, it is explicitly allocated or unbilled.
 */
export const BILLING_SOURCE_CATALOGUE = {
	tenant_container: {
		label: 'Tenant microVMs',
		placement: 'bare_metal',
		allocation: 'direct',
		billable: true,
		description: 'MicroVM CPU time and resident memory attributed by organization label.'
	},
	core_shared: {
		label: 'Core shared service',
		placement: 'bare_metal',
		allocation: 'shared_equal',
		billable: true,
		description: 'Core process CPU and RAM divided equally across ready tenants.'
	},
	redis_shared: {
		label: 'Redis shared service',
		placement: 'bare_metal',
		allocation: 'shared_equal',
		billable: true,
		description: 'Redis CPU, RAM, and persistence divided equally across ready tenants.'
	},
	durable_streams: {
		label: 'Durable Streams',
		placement: 'bare_metal',
		allocation: 'shared_weighted',
		billable: true,
		description:
			'Stream bytes attributed directly by organization; shared CPU and RAM weighted by stream bytes.'
	},
	workspace_source: {
		label: 'Workspace source',
		placement: 'bare_metal',
		allocation: 'direct',
		billable: true,
		description: 'Tenant source trees stored under the organization workspace root.'
	},
	runtime_files: {
		label: 'Runtime files',
		placement: 'bare_metal',
		allocation: 'direct',
		billable: true,
		description: 'Tenant-uploaded and runtime-generated files.'
	},
	checkpoint_cache: {
		label: 'Checkpoint cache',
		placement: 'bare_metal',
		allocation: 'direct',
		billable: true,
		description: 'Tenant deployment checkpoint cache.'
	},
	channel_auth: {
		label: 'Channel credentials',
		placement: 'bare_metal',
		allocation: 'direct',
		billable: true,
		description: 'Channel authentication state attributed through channel configuration ownership.'
	},
	redis_persistence: {
		label: 'Redis persistence',
		placement: 'bare_metal',
		allocation: 'shared_equal',
		billable: true,
		description: 'Redis AOF persistence divided equally across ready tenants.'
	},
	tenant_database: {
		label: 'Tenant database',
		placement: 'external',
		allocation: 'direct',
		billable: true,
		description: 'Neon PostgreSQL database bytes measured inside each tenant database.'
	},
	system_database: {
		label: 'System database',
		placement: 'external',
		allocation: 'shared_weighted',
		billable: true,
		description:
			'System PostgreSQL bytes allocated using organization-owned row bytes, including a proportional share of indexes and database overhead.'
	},
	object_storage: {
		label: 'Object storage',
		placement: 'external',
		allocation: 'direct',
		billable: true,
		description: 'R2 object bytes attributed by tenant object key.'
	},
	lightpanda_capacity: {
		label: 'Browser service',
		placement: 'bare_metal',
		allocation: 'platform',
		billable: false,
		description:
			'Actual Lightpanda container CPU and RAM are visible as platform overhead and remain unbilled until request-level attribution exists.'
	},
	website_capacity: {
		label: 'Public website',
		placement: 'bare_metal',
		allocation: 'platform',
		billable: false,
		description:
			'Actual website container CPU and RAM are visible as platform overhead and are never allocated to a tenant.'
	},
	host_platform: {
		label: 'Host platform overhead',
		placement: 'bare_metal',
		allocation: 'platform',
		billable: false,
		description:
			'Actual Docker container CPU and RAM for Dokploy, Traefik, and other unattributed services are recorded as platform overhead.'
	},
	openrouter: {
		label: 'OpenRouter',
		placement: 'external',
		allocation: 'direct',
		billable: true,
		description: 'Provider-reported request cost attributed directly to the tenant and generation.'
	}
} as const satisfies Record<BillingSourceId, BillingSourceDefinition>;

export const BILLING_RESOURCE_UNITS = {
	cpu: 'millicore-second',
	ram: 'MiB-second',
	disk_local: 'MiB-minute',
	disk_neon: 'MiB-minute',
	disk_r2: 'MiB-minute',
	ai: 'micro-SGD'
} as const satisfies Record<BillingResourceType, string>;

export const BILLING_MAX_GAUGE_SAMPLE_INTERVAL_SECONDS = 10 * 60;

export function isUsageBillableSubscriptionStatus(status: string | null | undefined): boolean {
	return status === 'active' || status === 'past_due';
}

export type BillingIntegrationInput = {
	resource: BillingResourceType;
	status: BillingMeasurementStatus;
	observedValue: string | null;
	weight: number;
	previous: { observedValue: string | null; measuredAt: string } | undefined;
	measuredAtMs: number;
};

export type BillingIntegrationResult = {
	intervalSeconds: number;
	quantity: number;
	counterReset: boolean;
};

function nonNegativeCounter(value: string, label: string): bigint {
	if (!/^\d+(?:\.0+)?$/.test(value)) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return BigInt(value.split('.')[0] ?? '0');
}

function safeInteger(value: bigint, label: string): number {
	const converted = Number(value);
	if (!Number.isSafeInteger(converted)) {
		throw new Error(`${label} exceeds the safe integer range`);
	}
	return converted;
}

/** Convert one raw source observation into the exact integer sent to Stripe. */
export function integrateBillingObservation(
	input: BillingIntegrationInput
): BillingIntegrationResult {
	if (
		!Number.isFinite(input.weight) ||
		input.weight < 0 ||
		input.weight > 1 ||
		!Number.isFinite(input.measuredAtMs)
	) {
		throw new Error('Billing integration weight and timestamp must be valid');
	}
	if (input.status !== 'measured' || input.observedValue === null) {
		return { intervalSeconds: 0, quantity: 0, counterReset: false };
	}
	const elapsedSeconds = input.previous
		? Math.round((input.measuredAtMs - new Date(input.previous.measuredAt).getTime()) / 1_000)
		: 0;
	if (!Number.isFinite(elapsedSeconds)) {
		throw new Error('Previous billing measurement timestamp is invalid');
	}
	if (input.resource === 'cpu') {
		if (!input.previous?.observedValue || elapsedSeconds <= 0) {
			return {
				intervalSeconds: Math.max(0, elapsedSeconds),
				quantity: 0,
				counterReset: false
			};
		}
		const current = nonNegativeCounter(input.observedValue, 'CPU counter');
		const prior = nonNegativeCounter(input.previous.observedValue, 'Previous CPU counter');
		if (current < prior) {
			return { intervalSeconds: elapsedSeconds, quantity: 0, counterReset: true };
		}
		const weightScale = 1_000_000_000n;
		const scaledWeight = BigInt(Math.round(input.weight * Number(weightScale)));
		const divisor = 1_000_000n * weightScale;
		const roundedQuantity = ((current - prior) * scaledWeight + divisor / 2n) / divisor;
		return {
			intervalSeconds: elapsedSeconds,
			quantity: safeInteger(roundedQuantity, 'CPU meter quantity'),
			counterReset: false
		};
	}
	const intervalSeconds = Math.max(
		0,
		Math.min(elapsedSeconds, BILLING_MAX_GAUGE_SAMPLE_INTERVAL_SECONDS)
	);
	if (intervalSeconds === 0) {
		return { intervalSeconds: 0, quantity: 0, counterReset: false };
	}
	const bytes = Number(input.observedValue);
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error('Billing gauge must be a non-negative safe integer byte value');
	}
	const mib = bytes / 1024 ** 2;
	const quantity =
		input.resource === 'ram'
			? Math.round(mib * intervalSeconds)
			: Math.round(mib * (intervalSeconds / 60));
	return { intervalSeconds, quantity, counterReset: false };
}

/** Parse the byte component of a Durable Streams `Stream-Next-Offset`. */
export function durableStreamByteOffset(offset: string): number {
	const match = /^\d+_(\d+)$/.exec(offset);
	if (!match) throw new Error(`Invalid Durable Streams offset: ${offset}`);
	const bytes = Number(match[1]);
	if (!Number.isSafeInteger(bytes) || bytes < 0) {
		throw new Error(`Unsafe Durable Streams byte offset: ${offset}`);
	}
	return bytes;
}
