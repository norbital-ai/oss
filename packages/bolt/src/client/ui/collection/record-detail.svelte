<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Inline, Stack } from '@norbital-ai/ui/layout';

	interface TimelineEvent {
		readonly id?: string;
		readonly kind: string;
		readonly subjectId?: string;
		readonly payload?: unknown;
		readonly at?: string;
	}

	let {
		record = null,
		loading = false,
		error,
		onretry,
		timeline = [],
		approvalId = null,
		locked = false,
		onapprove,
		onreject,
		onwithdraw
	}: {
		record?: Readonly<Record<string, unknown>> | null;
		loading?: boolean;
		error?: string;
		onretry?: () => void;
		timeline?: ReadonlyArray<TimelineEvent>;
		approvalId?: string | null;
		locked?: boolean;
		onapprove?: () => void;
		onreject?: () => void;
		onwithdraw?: () => void;
	} = $props();

	let entries = $derived(record === null ? [] : Object.entries(record));
	let showApproval = $derived(locked || Boolean(approvalId));
	let approvalEvents = $derived(
		timeline.map((event, index) => ({
			key: event.id ?? `${event.kind}:${event.subjectId ?? ''}:${event.at ?? index}`,
			kind: event.kind,
			actor: timelineActor(event),
			at: event.at,
			time: timelineTime(event)
		}))
	);

	const readStringField = (value: unknown, key: string): string | undefined => {
		if (value === null || typeof value !== 'object') return undefined;
		const field = Reflect.get(value, key);
		return typeof field === 'string' && field.length > 0 ? field : undefined;
	};

	const timelineActor = (event: TimelineEvent): string => {
		if (event.subjectId !== undefined && event.subjectId.length > 0) return event.subjectId;
		for (const key of ['actor', 'decidedBy', 'withdrawnBy'] as const) {
			const actor = readStringField(event.payload, key);
			if (actor !== undefined) return actor;
		}
		return '—';
	};

	const timelineTime = (event: TimelineEvent): string => {
		if (event.at === undefined || event.at.length === 0) return '—';
		const parsed = Date.parse(event.at);
		return Number.isNaN(parsed) ? event.at : new Date(parsed).toLocaleString();
	};
</script>

<section aria-labelledby="record-detail-title" aria-busy={loading}>
	<Stack gap="md">
		<h2 id="record-detail-title">Record detail</h2>
		{#if error}
			<div role="alert">
				<p>{error}</p>
				{#if onretry}<button type="button" onclick={onretry}>Try again</button>{/if}
			</div>
		{:else if loading}
			<p role="status">Loading record…</p>
		{:else if record === null}
			<p>Select a record to inspect its fields.</p>
		{:else if entries.length === 0}
			<p>This record has no visible fields.</p>
		{:else}
			<dl>
				{#each entries as [name, value] (name)}
					<div>
						<dt>{name.replaceAll('_', ' ')}</dt>
						<dd>{value === null || value === undefined ? '—' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}</dd>
					</div>
				{/each}
			</dl>
		{/if}

		{#if showApproval}
			<Stack gap="sm">
				<p role="status">Locked pending approval</p>
				{#if onapprove !== undefined || onreject !== undefined || onwithdraw !== undefined}
					<Inline gap="sm">
						{#if onapprove !== undefined}
							<Button type="button" size="sm" onclick={onapprove}>Approve</Button>
						{/if}
						{#if onreject !== undefined}
							<Button type="button" size="sm" variant="destructive" onclick={onreject}>Reject</Button>
						{/if}
						{#if onwithdraw !== undefined}
							<Button type="button" size="sm" variant="outline" onclick={onwithdraw}>Withdraw</Button>
						{/if}
					</Inline>
				{/if}
				{#if approvalEvents.length === 0}
					<p>No approval events yet.</p>
				{:else}
					<ol aria-label="Approval timeline">
						{#each approvalEvents as event (event.key)}
							<li>
								<Inline gap="sm">
									<span>{event.kind}</span>
									<span>{event.actor}</span>
									{#if event.at !== undefined}
										<time datetime={event.at}>{event.time}</time>
									{:else}
										<span>{event.time}</span>
									{/if}
								</Inline>
							</li>
						{/each}
					</ol>
				{/if}
			</Stack>
		{/if}
	</Stack>
</section>

<style>
	h2 { margin-block-start: 0; }
	dl { display: grid; gap: .75rem; }
	dl div { display: grid; grid-template-columns: minmax(8rem, 1fr) 2fr; gap: 1rem; }
	dt { font-weight: 600; text-transform: capitalize; }
	dd { margin: 0; overflow-wrap: anywhere; }
	ol { margin: 0; padding: 0; list-style: none; display: grid; gap: .25rem; }
</style>
