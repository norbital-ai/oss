<!--
@component
A `state` field's value as a coloured pill, in its words (`label`, else the catalog's, else the value humanized).
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	/** The props of `StateBadge`. */
	export type StateBadgeProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The state value; its tone picks the colour. */
		state: string;
		/** Overrides the shown words. */
		label?: string;
		/** Classes for the badge. */
		class?: string;
	};
</script>

<script lang="ts">
	import Badge from '../primitives/badge/badge.svelte';
	import { use_enum_text } from '../model/context.js';
	import { tone } from './kind.js';

	let { ctx, state, label, class: className }: StateBadgeProps = $props();
	const words = use_enum_text(() => ctx);
	const VARIANT = {
		neutral: 'outline',
		info: 'info',
		success: 'success',
		warning: 'warning',
		danger: 'destructive'
	} as const;
</script>

<Badge variant={VARIANT[tone(state)]} class={className} data-state-value={state}>
	{label ?? words(state)}
</Badge>
