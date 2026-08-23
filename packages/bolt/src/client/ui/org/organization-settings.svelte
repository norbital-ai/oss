<script lang="ts">
	import { Effect, Schema } from 'effect';
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
	import { workspaceSession } from '#lib/client/session.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import { OrganizationHostSnapshotSchema } from './organization-state.js';

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
	let { tenantId, client }: { tenantId: string; client: WorkspaceClient } = $props();

	const session = workspaceSession();

	let profile = $state<OrganizationDraft>({ ...EMPTY_ORGANIZATION_DRAFT });
	let usage = $state<ReadonlyArray<MeteredObservation>>([]);
	let usageEstimate = $state<PeriodEstimate>(EMPTY_PERIOD_ESTIMATE);
	let stripeDashboardUrl = $state('https://dashboard.stripe.com/');
	let hostLoading = $state(true);
	let hostFailure = $state<string | null>(null);
	let activeTab = $state('general');
	const manifestQuery = $derived(client.system.workspace.manifest({}));
	/** Whether the Stripe-backed figures have been asked for. They are fetched at most once. */
	let billingLoaded = $state(false);

	/**
	 * Reads the host's view of this tenant: the organization record and the metered ledger.
	 *
	 * Both come from the host's operations seam because both are the host's measurement, not tenant
	 * state — the runtime meters nothing and holds no organization attributes.
	 */
	const loadHost = (): Effect.Effect<void> =>
		Effect.gen(function* () {
			hostLoading = true;
			hostFailure = null;
			// Billing only when the Billing tab is the one being shown. General renders a name, a slug
			// and a logo, and used to wait on two sequential Stripe calls to do it.
			const snapshot = yield* Effect.tryPromise(() =>
				session.operations.read({ billing: activeTab === 'billing' })
			).pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrganizationHostSnapshotSchema)));
			profile = snapshot.organization;
			usage = snapshot.usage;
			usageEstimate = snapshot.usageEstimate ?? EMPTY_PERIOD_ESTIMATE;
			stripeDashboardUrl = snapshot.stripeDashboardUrl;
		}).pipe(
			Effect.catch(() => {
				hostFailure = 'Unable to read host state.';
				return Effect.void;
			}),
			Effect.ensuring(Effect.sync(() => (hostLoading = false)))
		);

	void Effect.runPromise(loadHost());
</script>

{#snippet generalContent()}
	<GeneralPane
		bind:profile
		slug={tenantId}
		defaultName={manifestQuery.current?.name}
		loading={hostLoading}
		loadFailure={hostFailure}
	/>
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
					onValueChange={(next) => {
						activeTab = next;
						// Fetched the first time Billing is opened, and not again. The initial load skips
						// Stripe so General renders immediately; opening Billing is the moment somebody has
						// actually asked for the numbers, and is where the round trip belongs.
						if (next === 'billing' && !billingLoaded) {
							billingLoaded = true;
							void Effect.runPromise(loadHost());
						}
					}}
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
