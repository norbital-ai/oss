<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';
	import { formatCalendarDate } from '../../lib/ui/display-formatters.js';
	import { leaveEventSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	let props: RendererProps = $props();
	const parsed = $derived(leaveEventSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	// svelte-ignore state_referenced_locally -- the editor intentionally starts from the incoming value.
	let draft = $state(JSON.stringify(props.value ?? null, null, 2));
	let error = $state<string | null>(null);

	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.kind === 'TIME_OFF')
			return `${formatCalendarDate(current.from_date)} → ${formatCalendarDate(current.to_date)} · ${current.days}d`;
		return `${current.kind.replaceAll('_', ' ').toLowerCase()} · ${formatCalendarDate(current.effective_on)} · ${current.movement_days}d`;
	});

	function update(raw: string): void {
		draft = raw;
		try {
			const next = leaveEventSchema.safeParse(JSON.parse(raw));
			if (!next.success) {
				error = 'The event does not match the selected variant.';
				return;
			}
			error = null;
			if (props.mode === 'edit') props.onValueChange(next.data as Value);
		} catch {
			error = 'Enter valid JSON.';
		}
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack gap="xs" class="rounded-md border border-border bg-muted/20 p-3">
		<label class="text-sm font-medium" for="leave-event-json">Leave event</label>
		<textarea
			id="leave-event-json"
			class="min-h-48 w-full rounded-md border bg-background p-3 font-mono text-xs"
			value={draft}
			disabled={props.disabled}
			oninput={(event) => update(event.currentTarget.value)}></textarea>
		{#if error}<p class="text-xs text-destructive">{error}</p>{/if}
	</Stack>
{/if}
