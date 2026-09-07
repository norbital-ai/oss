<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { TabConfig } from '#lib/tabs/tabs.types';

	export interface RecordShellProps {
		/** Record heading (for example the SKU, issue number, or subject). */
		title: string;
		/** One muted line under the heading (state, owner, summary). */
		subtitle?: string;
		/** Right-aligned header actions (for example a Process button). */
		actions?: Snippet;
		/**
		 * Tab strip rendered under the header. Records keep their tab configs; the shell
		 * owns placement, animation, and spacing so every record reads the same.
		 */
		tabs?: TabConfig[];
		/** Content when `tabs` is omitted (for example a create form or a message body). */
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { Inline, Stack } from '#lib/layout';
	import { Tabs } from '#lib/tabs';

	let { title, subtitle, actions, tabs, children }: RecordShellProps = $props();
</script>

<!--
	Record detail composition: compact header (title, optional subtitle, optional actions)
	then the tab strip or plain content. The header stays subordinate to the framework
	dialog chrome (record label, UI/Approval tabs, expand, close) — it only carries what
	the chrome does not. Spacing belongs to the parent Stack, never margins on content.
-->
<Stack gap="md">
	<Inline align="start" justify="between" gap="md">
		<Stack gap="xs" class="min-w-0">
			<h2 class="text-base font-semibold">{title}</h2>
			{#if subtitle != null && subtitle !== ''}
				<p class="text-xs text-muted-foreground">{subtitle}</p>
			{/if}
		</Stack>
		{#if actions}
			{@render actions()}
		{/if}
	</Inline>
	{#if tabs != null}
		<!--
			No chrome insets here: the tab strip and its panels align flush with the header
			text above. Tab content must not add its own padding.
		-->
		<Tabs animate={false} contentPadding={false} listClass="w-full" config={tabs} />
	{:else if children}
		{@render children()}
	{/if}
</Stack>
