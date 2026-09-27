<!--
@component
A `state` field's value as a coloured pill.
-->
<script lang="ts" module>
	/** The props of `StateBadge`. */
	export type StateBadgeProps = { state: string; label?: string; class?: string };
</script>

<script lang="ts">
	import Badge from '../primitives/badge/badge.svelte';
	import { tone } from './kind.js';

	let { state, label, class: className }: StateBadgeProps = $props();
	const VARIANT = { neutral: 'outline', info: 'info', success: 'success', warning: 'warning', danger: 'destructive' } as const;
</script>

<Badge variant={VARIANT[tone(state)]} class={className} data-state-value={state}>
	{label ?? state.replace(/_/g, ' ')}
</Badge>
