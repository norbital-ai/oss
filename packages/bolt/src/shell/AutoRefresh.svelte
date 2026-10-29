<!--
	An opt-in Auto-refresh toggle for a one-off read of a store outside the tenant database (Logs, Audit): off by
	default; while on, `onRefresh` runs every ten seconds the page is visible.
-->
<script lang="ts">
	import { Checkbox } from '@norbital-ai/ui';
	import { attach } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { visible } from '../page/stream.ts';

	let { t, onRefresh }: { t: (key: string) => string; onRefresh: () => void } = $props();
	let on = $state(false);
	const every = Effect.sleep('10 seconds').pipe(
		Effect.andThen(visible),
		Effect.andThen(Effect.sync(() => onRefresh())),
		Effect.forever
	);
</script>

<label
	class="flex items-center gap-2 text-xs text-muted-foreground"
	data-auto-refresh={on}
	{@attach attach(() => (on ? every : Effect.void))}
>
	<Checkbox bind:checked={on} />{t('Auto-refresh')}
</label>
