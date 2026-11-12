<script lang="ts">
	import { date_time, BRIEF_TIMESTAMP } from '../i18n.ts';
	import { Icon } from '@norbital-ai/ui';
	import type { SvelteSet } from 'svelte/reactivity';
	import type { Decided } from './decisions.ts';
	let { decision, cls, opened, t }: {
		decision: Decided;
		cls: string;
		opened: SvelteSet<string>;
		t: (key: string) => string;
	} = $props();
	const event = $derived(decision.event);
	const d = $derived(decision.d);
	const open = $derived(opened.has(event.id));
</script>

	<button
		type="button"
		data-decision-toggle
		aria-expanded={open}
		aria-label={t('Decision')}
		title={date_time(event.at, undefined, BRIEF_TIMESTAMP)}
		class="{cls} flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {d.error ===
		undefined
			? ''
			: 'text-destructive'}"
		onclick={() => (open ? opened.delete(event.id) : opened.add(event.id))}
	>
		<Icon name="lucide:scale" class="size-3.5" /><span>{t('Decision')}</span>
	</button>
