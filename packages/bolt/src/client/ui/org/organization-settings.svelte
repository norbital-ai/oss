<script lang="ts">
	import { Bound, Cluster, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import BillingPane, {
		EMPTY_PERIOD_ESTIMATE,
		type MeteredObservation,
		type PeriodEstimate
	} from './organization-billing.svelte';
	import GeneralPane, {
		EMPTY_ORGANIZATION_DRAFT,
		type OrganizationDraft
	} from './organization-general.svelte';
	import { workspaceSession } from '../../session.js';

	/**
	 * The Organization surface: the organization's own attributes and what it has been billed for.
	 * Nothing about the people in it — members, invitations, teams and access events are rendered by
	 * the shell's own settings surface at the settings root, fed by `identity.workspaceAccess`, and
	 * are deliberately not repeated here. Nothing about what the workspace *contains* — its
	 * collections, apps, policies, agents, version, required facilities and the host's facility
	 * availability are Workspace Studio's subject, and were deleted from here rather than moved,
	 * because Studio ports that surface itself.
	 *
	 * Two transports, because two authorities own the data.
	 *
	 * The profile is host state. In the legacy Core app it is columns on the `organization` row of
	 * the system database, written by `saveOrganizationWorkspaceDetails` — never by the tenant — and
	 * the host owns it, so it is read and written through the host operations seam. Bolt is not
	 * asked: `bolt_workspace_identity_settings` is a two-column tenant table with a reader and no
	 * writer, and `dispatch.ts` has no command that mutates a workspace attribute at all.
	 *
	 * Both reads live here rather than in the panes because `Tabs` unmounts the pane it is leaving: a
	 * pane that fetched for itself would re-read the whole operations snapshot — which carries the
	 * workspace's entire source tree — on every tab switch.
	 */
	let { tenantId }: { tenantId: string } = $props();

	const session = workspaceSession();

	let profile = $state<OrganizationDraft>({ ...EMPTY_ORGANIZATION_DRAFT });
	let usage = $state<ReadonlyArray<MeteredObservation>>([]);
	let usageEstimate = $state<PeriodEstimate>(EMPTY_PERIOD_ESTIMATE);
	let stripeDashboardUrl = $state('https://dashboard.stripe.com/');
	let hostLoading = $state(true);
	let hostFailure = $state<string | null>(null);
	let activeTab = $state('general');

	/** Reads a string field off an untyped payload, treating anything else as absent. */
	const text = (row: unknown, field: string): string => {
		const value = row === null || typeof row !== 'object' ? undefined : Reflect.get(row, field);
		return typeof value === 'string' ? value : '';
	};
	/** Reads an array field off an untyped payload, treating anything else as empty. */
	const list = (payload: unknown, field: string): ReadonlyArray<unknown> => {
		const value =
			payload === null || typeof payload !== 'object' ? undefined : Reflect.get(payload, field);
		return Array.isArray(value) ? value : [];
	};
	/**
	 * Reads a finite number off an untyped host payload. Missing or non-numeric fields stay
	 * non-finite so the estimate decoder can reject a partial object instead of treating it as zero.
	 */
	function amount(row: unknown, field: string): number {
		if (row === null || typeof row !== 'object') {
			return Number.NaN;
		}
		const value = Reflect.get(row, field);
		if (typeof value !== 'number') {
			return Number.NaN;
		}
		if (!Number.isFinite(value)) {
			return Number.NaN;
		}
		return value;
	}

	/**
	 * Reads the host's view of this tenant: the organization record and the metered ledger.
	 *
	 * Both come from the host's operations seam because both are the host's measurement, not tenant
	 * state — the runtime meters nothing and holds no organization attributes.
	 */
	const loadHost = async (): Promise<void> => {
		hostLoading = true;
		hostFailure = null;
		try {
			const snapshot: unknown = await session.operations.read();
			const stored = Reflect.get(Object(snapshot), 'organization');
			profile = {
				name: text(stored, 'name'),
				description: text(stored, 'description'),
				countryCode: text(stored, 'countryCode'),
				companySize: text(stored, 'companySize'),
				logoKey: text(stored, 'logoKey') === '' ? null : text(stored, 'logoKey')
			};
			// A record nobody has saved yet reads as a wall of blank fields. The workspace the tenant
			// routes is named by its own manifest, so until the organization is given a name of its
			// own the form opens on that name — the first save then persists it with the rest.
			if (profile.name === '') {
				const summary: unknown = await session.transport
					.command('workspace.manifest', {})
					.catch(() => undefined);
				const workspaceName = text(summary, 'name');
				if (workspaceName !== '') profile.name = workspaceName;
			}
			usage = list(snapshot, 'usage').map((row) => ({
				kind: text(row, 'kind'),
				quantity: Number(Reflect.get(Object(row), 'quantity') ?? 0),
				// No fallback: a row the host sent without its observation time is left non-finite so it
				// is reported as undated, rather than dated at a moment nothing was measured.
				observedAtMillis: Number(Reflect.get(Object(row), 'observedAtMillis'))
			}));
			const snapshotEstimate = Reflect.get(Object(snapshot), 'usageEstimate');
			const periodStartMillis = amount(snapshotEstimate, 'periodStartMillis');
			const periodEndMillis = amount(snapshotEstimate, 'periodEndMillis');
			const asOfMillis = amount(snapshotEstimate, 'asOfMillis');
			const monthToDateMicroSgd = amount(snapshotEstimate, 'monthToDateMicroSgd');
			const projectedMicroSgd = amount(snapshotEstimate, 'projectedMicroSgd');
			usageEstimate =
				Number.isFinite(periodStartMillis) && Number.isFinite(periodEndMillis)
					? {
							periodStartMillis,
							periodEndMillis,
							asOfMillis: Number.isFinite(asOfMillis) ? asOfMillis : periodStartMillis,
							monthToDateMicroSgd: Number.isFinite(monthToDateMicroSgd) ? monthToDateMicroSgd : 0,
							projectedMicroSgd: Number.isFinite(projectedMicroSgd) ? projectedMicroSgd : 0,
							meters: list(snapshotEstimate, 'meters').map((row) => {
								const monthToDateQuantity = amount(row, 'monthToDateQuantity');
								const projectedQuantity = amount(row, 'projectedQuantity');
								const meterMonthToDate = amount(row, 'monthToDateMicroSgd');
								const meterProjected = amount(row, 'projectedMicroSgd');
								return {
									kind: text(row, 'kind'),
									monthToDateQuantity: Number.isFinite(monthToDateQuantity)
										? monthToDateQuantity
										: 0,
									projectedQuantity: Number.isFinite(projectedQuantity) ? projectedQuantity : 0,
									monthToDateMicroSgd: Number.isFinite(meterMonthToDate) ? meterMonthToDate : 0,
									projectedMicroSgd: Number.isFinite(meterProjected) ? meterProjected : 0,
									method: text(row, 'method')
								};
							})
						}
					: EMPTY_PERIOD_ESTIMATE;
			stripeDashboardUrl = text(snapshot, 'stripeDashboardUrl') || 'https://dashboard.stripe.com/';
		} catch (cause) {
			hostFailure = cause instanceof Error ? cause.message : 'Unable to read host state.';
		} finally {
			hostLoading = false;
		}
	};

	void loadHost();
</script>

{#snippet generalContent()}
	<GeneralPane bind:profile slug={tenantId} loading={hostLoading} loadFailure={hostFailure} />
{/snippet}

{#snippet billingContent()}
	<BillingPane
		{usage}
		{usageEstimate}
		{stripeDashboardUrl}
		loading={hostLoading}
		loadFailure={hostFailure}
	/>
{/snippet}

<!-- Root navigation follows the product's page-heading rhythm, as Workspace Studio does: title, one
     line of what the page is for, then the rail. The header sits on the background, not in a card. -->
<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">Organization</h1>
				<p class="max-w-2xl text-meta">Your organization profile and its billing.</p>
			</Stack>
			<Cluster gap="sm" align="center" shrink={false}>
				<Tabs
					value={activeTab}
					onValueChange={(next) => (activeTab = next)}
					showContent={false}
					animate={false}
					variant="default"
					layout="responsive"
					class="min-w-0 flex-1 !shrink"
					listClass="mx-0 w-full"
					config={[
						{
							name: 'general',
							label: 'General',
							icon: 'lucide:building-2',
							content: ''
						},
						{
							name: 'billing',
							label: 'Billing',
							icon: 'lucide:credit-card',
							content: ''
						}
					] satisfies TabConfig[]}
				/>
			</Cluster>
		</Stack>
	{/snippet}

	<!-- One page gutter for the whole body, matching the tab strip's own: the same left/right padding
	     as the header, and the same top gap below the triggers that the header opens with. The pane
	     renders flush inside, so its content lines up with the strip on every axis. -->
	<Inline align="stretch" gap="none" fill class="px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
		<Bound size="full" grow clip class="relative min-w-0 bg-background font-sans">
			{#if activeTab === 'general'}
				{@render generalContent()}
			{:else}
				{@render billingContent()}
			{/if}
		</Bound>
	</Inline>
</Cover>
