<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { TabConfig } from '#lib/tabs/tabs.types';

	export interface RecordShellProps {
		/**
		 * Record heading. Omit where the framework chrome already names the record — the record
		 * sheet's header carries the record label, and repeating it here reads as a second title.
		 */
		title?: string;
		/** One muted line under the heading (state, owner, summary). */
		subtitle?: string;
		/**
		 * Leading Iconify icon (for example a lock on a read-only record). Muted: the shell
		 * stays subordinate to the framework dialog chrome.
		 */
		icon?: string;
		/**
		 * Short state pill beside the heading (for example the framework's read-only label).
		 * The caller passes the translated string; the shell only places it.
		 */
		badge?: string;
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
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { Inline, Stack } from '#lib/layout';
	import { Tabs } from '#lib/tabs';

	let { title, subtitle, icon, badge, actions, tabs, children }: RecordShellProps = $props();
</script>

<!--
	Record detail composition: one compact header row (optional icon, heading, state pill,
	optional actions) then the tab strip or plain content. The header stays subordinate to
	the framework dialog chrome (record label, UI/Approval tabs, expand, close) — it only
	carries what the chrome does not. Spacing belongs to the parent Stack, never margins
	on content.
-->
<Stack gap="md">
	{#if title != null || subtitle != null || icon != null || badge != null || actions}
		<Inline align="start" justify="between" gap="md">
			<Inline align="center" gap="sm" class="min-w-0">
				{#if icon != null}
					<Icon icon={icon} class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{/if}
				{#if title != null || (subtitle != null && subtitle !== '')}
					<Stack gap="xs" class="min-w-0">
						{#if title != null}
							<h2 class="text-base font-semibold">{title}</h2>
						{/if}
						{#if subtitle != null && subtitle !== ''}
							<p class="text-xs text-muted-foreground">{subtitle}</p>
						{/if}
					</Stack>
				{/if}
				{#if badge != null && badge !== ''}
					<Badge variant="outline" class="shrink-0">{badge}</Badge>
				{/if}
			</Inline>
			{#if actions}
				{@render actions()}
			{/if}
		</Inline>
	{/if}
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
