<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { SourceSnapshot, StudioReviewTab } from './studio-state.js';

	/**
	 * Review's main viewport: where a proposed release would be read before it is let into Live.
	 *
	 * The Schema tab is the one review this host can actually perform: `schema.plan` answers with
	 * the exact DDL a release would apply, in the order it applies it, and `schema.verify` says
	 * whether the live database already matches. The other two tabs read what the host cannot show —
	 * there is no release-request, merge-request or proposed-change entity, and no read path over
	 * the source log — so their empty states name the thing they cannot show rather than reading as
	 * "nothing has happened yet".
	 */
	let {
		tab = 'requests',
		source,
		command
	}: {
		tab?: StudioReviewTab;
		source?: SourceSnapshot | undefined;
		command: (name: string, input: Readonly<Record<string, string>>) => Promise<unknown>;
	} = $props();

	const fileCount = $derived(Object.keys(source?.files ?? {}).length);

	const PlanSchema = Schema.Struct({
		fingerprint: Schema.String,
		steps: Schema.Array(Schema.Struct({ id: Schema.String, sql: Schema.String }))
	});

	let plan = $state<typeof PlanSchema.Type | undefined>();
	let planError = $state<string | undefined>();
	let checking = $state(false);
	let checkResult = $state<string | undefined>();

	/** The DDL a release would apply, read once when the tab opens rather than on a timer. */
	const loadPlan = async (): Promise<void> => {
		try {
			plan = await Effect.runPromise(
				Schema.decodeUnknownEffect(PlanSchema)(await command('schema.plan', {}))
			);
			planError = undefined;
		} catch (cause) {
			plan = undefined;
			planError = cause instanceof Error ? cause.message : String(cause);
		}
	};

	/** `validate` checks the plan is coherent; `verify` checks the live database matches it. */
	const check = async (name: 'schema.validate' | 'schema.verify'): Promise<void> => {
		checking = true;
		checkResult = undefined;
		try {
			checkResult = `${name}: ${JSON.stringify(await command(name, {}))}`;
		} catch (cause) {
			checkResult = `${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`;
		} finally {
			checking = false;
		}
	};

	onMount(() => {
		if (tab === 'schema') void loadPlan();
	});
</script>

{#snippet unavailable(icon: string, heading: string, body: string, detail: string)}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-center">
		<Icon {icon} class="size-10 text-muted-foreground/30" />
		<p class="text-sm font-medium text-foreground">{heading}</p>
		<p class="max-w-sm text-xs leading-relaxed text-muted-foreground">{body}</p>
		<p class="max-w-sm text-micro leading-relaxed text-amber-500" role="status">{detail}</p>
	</Stack>
{/snippet}

{#if tab === 'requests'}
	{@render unavailable(
		'lucide:git-compare',
		'No diff to show',
		'A review reads the difference between what is proposed and what is live.',
		'This host exposes no compare operation over source revisions or releases, so a diff cannot be built even for the revision it holds.'
	)}
{:else if tab === 'history'}
	{@render unavailable(
		'lucide:history',
		'No readable history',
		`Every commit writes a new revision — the host is holding revision ${source?.revision ?? 0}, ${fileCount} file${fileCount === 1 ? '' : 's'} — and every promotion appends to that environment’s deployment history.`,
		'Neither log has a read path: the source service keeps only the latest snapshot, and the deployment history is stored but exposed by no operation.'
	)}
{:else}
	<Stack gap="md" class="p-4 sm:p-6">
		<Stack as="section" gap="sm" data-testid="review-schema-plan">
			<Stack gap="xs">
				<h3 class="text-sm font-medium text-foreground">Schema</h3>
				<p class="max-w-2xl text-xs leading-relaxed text-muted-foreground">
					The DDL this workspace's schema resolves to, in the order a release applies it. This is
					the exact shape a release would bring to the database — read it before letting a build
					through.
				</p>
			</Stack>
			{#if planError !== undefined}
				<p class="text-xs text-destructive">Plan unavailable: {planError}</p>
			{:else if plan === undefined}
				<p class="text-meta">Reading the schema plan…</p>
			{:else}
				<p class="font-mono text-micro break-all text-foreground">{plan.fingerprint}</p>
				<p class="text-meta">
					{plan.steps.length} step{plan.steps.length === 1 ? '' : 's'} in the plan
				</p>
			{/if}
			<Cluster gap="xs">
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={checking}
					onclick={() => void check('schema.validate')}
				>
					Validate
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={checking}
					onclick={() => void check('schema.verify')}
				>
					Verify against database
				</Button>
			</Cluster>
			{#if checkResult !== undefined}
				<p class="text-micro break-all text-muted-foreground" aria-live="polite">{checkResult}</p>
			{/if}
		</Stack>
		{#if plan !== undefined && plan.steps.length > 0}
			<Scroll name="Schema plan" class="max-h-96 rounded-md border border-border/70">
				<ul class="divide-y divide-border/50">
					{#each plan.steps as step (step.id)}
						<li class="px-3 py-2">
							<p class="text-micro text-muted-foreground">{step.id}</p>
							<pre class="whitespace-pre-wrap font-mono text-micro text-foreground">{step.sql}</pre>
						</li>
					{/each}
				</ul>
			</Scroll>
		{/if}
	</Stack>
{/if}
