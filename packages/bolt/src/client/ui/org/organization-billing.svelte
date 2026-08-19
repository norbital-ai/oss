<script lang="ts" module>
	/**
	 * One row of the host's metered ledger, as the host's operations seam reports it.
	 *
	 * `observedAtMillis` is non-finite when the host sent a row without an observation time; such a
	 * row still counts towards its meter but is never dated, rather than being dated at a stand-in.
	 */
	export type MeteredObservation = {
		readonly kind: string;
		readonly quantity: number;
		readonly observedAtMillis: number;
	};

	/**
	 * One meter in the host's current UTC-month projection. Quantities stay in the meter's own unit;
	 * `*MicroSgd` is the locked Colony conversion the Stripe meter events already use.
	 */
	export type PeriodEstimateMeter = {
		readonly kind: string;
		readonly monthToDateQuantity: number;
		readonly projectedQuantity: number;
		readonly monthToDateMicroSgd: number;
		readonly projectedMicroSgd: number;
		readonly method: string;
	};

	/**
	 * The host's estimate for this UTC calendar month, as the host reports `usageEstimate`.
	 */
	export type PeriodEstimate = {
		readonly periodStartMillis: number;
		readonly periodEndMillis: number;
		readonly asOfMillis: number;
		readonly meters: ReadonlyArray<PeriodEstimateMeter>;
		readonly monthToDateMicroSgd: number;
		readonly projectedMicroSgd: number;
	};

	/** A missing or unreadable host estimate still leaves the pane one shape to render. */
	export const EMPTY_PERIOD_ESTIMATE: PeriodEstimate = {
		periodStartMillis: 0,
		periodEndMillis: 0,
		asOfMillis: 0,
		meters: [],
		monthToDateMicroSgd: 0,
		projectedMicroSgd: 0
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { buttonVariants } from '@norbital-ai/ui/button';
	import { Bound, Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';

	let {
		usage,
		usageEstimate,
		stripeDashboardUrl,
		loading,
		loadFailure
	}: {
		usage: ReadonlyArray<MeteredObservation>;
		usageEstimate: PeriodEstimate;
		stripeDashboardUrl: string;
		loading: boolean;
		loadFailure: string | null;
	} = $props();

	/**
	 * What each meter counts, taken from the conversion each one feeds in Colony's billing ledger:
	 * compute is integrated over active seconds, the two storage meters accrue GB-hours, and AI is
	 * the provider's own reported cost. Estimated SGD uses the same locked rates Stripe already
	 * receives, so the pane can show a month-end bill without a second rate table.
	 *
	 * This is the full meter set, in a fixed order: a meter the ledger never observed still exists
	 * and still has a unit, and a tenant that has never used AI should read as having used none,
	 * not as having no AI meter.
	 */
	const USAGE_UNITS: Readonly<Record<string, string>> = {
		compute: 'active seconds',
		database: 'GB-hours',
		files: 'GB-hours',
		ai: 'provider USD'
	};

	const USAGE_LABELS: Readonly<Record<string, string>> = {
		compute: 'Compute',
		database: 'Disc',
		files: 'Files',
		ai: 'AI'
	};

	const dated = new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});

	const formatQuantity = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

	const currency = new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency: 'SGD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});

	/**
	 * Formats a micro-SGD ledger amount for the billing pane. Sub-cent usage stays visible as a
	 * bound rather than rounding to a misleading zero, matching how small meter events still bill.
	 */
	function formatSgd(microSgd: number): string {
		if (!Number.isFinite(microSgd) || microSgd <= 0) {
			return currency.format(0);
		}
		if (microSgd < 10_000) {
			return '< SGD 0.01';
		}
		const major = microSgd / 1_000_000;
		if (!Number.isFinite(major)) {
			return currency.format(0);
		}
		return currency.format(major);
	}

	const periodLabel = $derived(
		usageEstimate.periodEndMillis > usageEstimate.periodStartMillis
			? `${dated.format(usageEstimate.periodStartMillis)} – ${dated.format(usageEstimate.periodEndMillis - 1)}`
			: 'This billing month'
	);

	/** Every known meter in a fixed order, with any kind the ledger observed that we do not know. */
	const meters = $derived(
		[
			...Object.keys(USAGE_UNITS),
			...[...new Set(usage.map((observation) => observation.kind))].filter(
				(kind) => USAGE_UNITS[kind] === undefined
			)
		].map((kind) => {
			const recorded = usage.filter((observation) => observation.kind === kind);
			const period = usageEstimate.meters.find((candidate) => candidate.kind === kind);
			return {
				kind,
				unit: USAGE_UNITS[kind] ?? 'units',
				monthToDateQuantity: period?.monthToDateQuantity ?? 0,
				projectedQuantity: period?.projectedQuantity ?? 0,
				observedAtMillis: recorded.reduce(
					(latest, observation) => Math.max(latest, observation.observedAtMillis),
					-Infinity
				)
			};
		})
	);
</script>

<Bound size="full">
	<Scroll name="Organization billing">
		{#if loading}
			<Inline align="center" gap="sm" class="py-8 text-sm text-muted-foreground">
				<Icon icon="lucide:loader-2" class="size-4 animate-spin" />
				Loading…
			</Inline>
		{:else if loadFailure}
			<div
				class="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
				role="alert"
			>
				{loadFailure}
			</div>
		{:else}
			<Stack gap="md">
				<Grid minimum="panel" gap="md">
					{#each meters as meter (meter.kind)}
						<section
							class="rounded-lg border border-border bg-card p-4 sm:p-6"
							aria-label={`${meter.kind} meter`}
						>
							<Stack gap="sm">
								<p class="text-overline">
									{USAGE_LABELS[meter.kind] ?? meter.kind}
								</p>
								<Stack gap="xs">
									<p class="truncate text-2xl font-semibold tabular-nums text-foreground">
										{formatQuantity.format(meter.monthToDateQuantity)}
									</p>
									<p class="text-meta">{meter.unit} this month</p>
								</Stack>
								<p class="text-meta">
									Est. month end:
									<span class="tabular-nums text-foreground">
										{formatQuantity.format(meter.projectedQuantity)}
									</span>
								</p>
								<p class="border-t pt-3 text-meta">
									Last observed:
									{Number.isFinite(meter.observedAtMillis)
										? dated.format(meter.observedAtMillis)
										: '—'}
								</p>
							</Stack>
						</section>
					{/each}
				</Grid>

				<section
					class="rounded-lg border border-border bg-card p-4 sm:p-6"
					aria-label="Estimated bill at month end"
				>
					<Stack gap="md">
						<Stack gap="xs">
							<h3 class="text-sm font-semibold text-foreground">Estimated bill at month end</h3>
							<p class="text-meta">
								{periodLabel}. Storage assumes the current size holds. Compute and AI follow this
								workspace's recorded weekday pattern. The final invoice is actual metered usage.
							</p>
						</Stack>
						<Stack gap="xs">
							<p class="text-3xl font-semibold tabular-nums text-foreground">
								{formatSgd(usageEstimate.projectedMicroSgd)}
							</p>
							<p class="text-meta">
								{formatSgd(usageEstimate.monthToDateMicroSgd)} so far this month
							</p>
						</Stack>
						<Stack gap="sm">
							{#each usageEstimate.meters as meter (meter.kind)}
								<Cluster justify="between" align="center" gap="md">
									<p class="text-meta">
										{USAGE_LABELS[meter.kind] ?? meter.kind}
									</p>
									<Cluster gap="md" align="center">
										<p class="text-meta tabular-nums">
											{formatQuantity.format(meter.projectedQuantity)}
											{USAGE_UNITS[meter.kind] ?? 'units'}
										</p>
										<p class="text-xs tabular-nums text-foreground">
											{formatSgd(meter.projectedMicroSgd)}
										</p>
									</Cluster>
								</Cluster>
							{/each}
						</Stack>
					</Stack>
				</section>

				<!-- The host bills through Stripe: the meters are reported to its billing meters and priced
				     in the host ledger, and this is where the operator sees the live subscription and usage. -->
				<section
					class="rounded-lg border border-border bg-card p-4 sm:p-6"
					aria-label="Billed through Stripe"
				>
					<Cluster align="start" justify="between" gap="md">
						<Stack gap="xs">
							<h3 class="text-sm font-semibold text-foreground">Billed through Stripe</h3>
							<p class="text-meta">
								This workspace's metered usage is reported to Stripe's billing meters and priced in
								the host's billing ledger. The Stripe dashboard shows the live subscription,
								invoices, and meter events for the connected account.
							</p>
						</Stack>
						<a
							class={buttonVariants({ variant: 'secondary', size: 'sm' })}
							href={stripeDashboardUrl}
							target="_blank"
							rel="noreferrer"
						>
							<Icon icon="lucide:external-link" class="mr-2 size-4" />
							Open Stripe dashboard
						</a>
					</Cluster>
				</section>
			</Stack>
		{/if}
	</Scroll>
</Bound>
