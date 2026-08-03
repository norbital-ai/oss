<script lang="ts">
	import { payComponentPolicySchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	let props: RendererProps = $props();
	const parsed = $derived(payComponentPolicySchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	// svelte-ignore state_referenced_locally -- the editor intentionally starts from the incoming value.
	let draft = $state(JSON.stringify(props.value ?? null, null, 2));
	let error = $state<string | null>(null);
	const summary = $derived(
		current === null
			? '—'
			: `${current.kind.replaceAll('_', ' ').toLowerCase()} · ${current.settlement.toLowerCase()} · ${current.statutory_treatments.length} statutory decisions`
	);

	function update(raw: string): void {
		draft = raw;
		try {
			const next = payComponentPolicySchema.safeParse(JSON.parse(raw));
			if (!next.success) {
				error = 'The policy does not match the selected structural variant.';
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
	<div class="grid gap-1.5 rounded-md border border-border bg-muted/20 p-3">
		<label class="text-sm font-medium" for="component-policy-json">Pay component policy</label>
		<textarea
			id="component-policy-json"
			class="min-h-64 w-full rounded-md border bg-background p-3 font-mono text-xs"
			value={draft}
			disabled={props.disabled}
			oninput={(event) => update(event.currentTarget.value)}></textarea>
		<p class="text-xs text-muted-foreground">
			The union fixes settlement direction; each statutory decision remains effective-dated.
		</p>
		{#if error}<p class="text-xs text-destructive">{error}</p>{/if}
	</div>
{/if}
