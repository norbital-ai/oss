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
		 * What the record is, in the reader's words ("Employment contract"). Inside the record sheet
		 * it replaces the collection name in the chrome, so two representations of related
		 * collections read as the two different things they are.
		 */
		kind?: string;
		/**
		 * Iconify icon inside the state pill (for example a lock on a read-only record). Inside the
		 * record sheet the pill trails the sheet's own record label; elsewhere it trails the shell's
		 * heading. Muted either way: the shell stays subordinate to the chrome.
		 */
		icon?: string;
		/**
		 * Short state pill carrying the icon (for example the framework's read-only label). The
		 * caller passes the translated string; the shell only places it.
		 */
		badge?: string;
		/** One sentence behind the pill, shown on hover: what the state means and what to do instead. */
		hint?: string;
		/**
		 * The record's actions (for example a Process button). Inside the record sheet they sit in the
		 * sheet's header beside its controls, so every record's actions are in the same place;
		 * elsewhere they trail the shell's own heading.
		 */
		actions?: Snippet;
		/**
		 * Tab strip rendered under the header. Records keep their tab configs; the shell
		 * owns placement, animation, and spacing so every record reads the same.
		 */
		tabs?: TabConfig[];
		/**
		 * Height contract from the caller, on the shell's own column. A record whose body owns its
		 * scrollport passes `h-full` so that body can take the height its host grants it; without
		 * one the column stays content-sized and the host's scrollport scrolls the whole record.
		 */
		class?: string;
		/** Content when `tabs` is omitted (for example a create form or a message body). */
		children?: Snippet;
	}
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { getOptionalCollectionRecordNoticeContext } from '#lib/collection-runtime';
	import { Inline, Stack } from '#lib/layout';
	import { Tabs } from '#lib/tabs';

	let {
		title,
		subtitle,
		kind,
		icon,
		badge,
		hint,
		actions,
		tabs,
		class: className,
		children
	}: RecordShellProps = $props();

	const hasState = $derived(icon != null || (badge != null && badge !== ''));
	/**
	 * The record sheet's header, when one is mounted above. Record state belongs in the chrome
	 * beside the record label, not in a second heading row that scrolls away with the body.
	 */
	const sheetHeader = getOptionalCollectionRecordNoticeContext();
	const stateInHeader = $derived(sheetHeader != null && hasState);
	$effect(() => {
		if (!stateInHeader || sheetHeader == null) return;
		sheetHeader.registerTrailing(recordState);
		return () => sheetHeader.registerTrailing(null);
	});
	const actionsInHeader = $derived(sheetHeader != null && actions != null);
	$effect(() => {
		if (!actionsInHeader || sheetHeader == null || actions == null) return;
		sheetHeader.registerActions(actions);
		return () => sheetHeader.registerActions(null);
	});
	$effect(() => {
		if (sheetHeader == null || kind == null) return;
		sheetHeader.registerKind(kind);
		return () => sheetHeader.registerKind(null);
	});
</script>

{#snippet recordState()}
	{#if badge != null && badge !== ''}
		<Badge
			variant="outline"
			class="shrink-0 gap-1"
			title={hint}
			aria-label={hint ? `${badge}: ${hint}` : undefined}
		>
			{#if icon != null}
				<Icon {icon} class="size-3 shrink-0" aria-hidden="true" />
			{/if}
			{badge}
		</Badge>
	{:else if icon != null}
		<Icon {icon} class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
	{/if}
{/snippet}

<!--
	Record detail composition: one compact header row (heading, trailing state pill,
	optional actions) then the tab strip or plain content. The header stays subordinate to
	the framework dialog chrome (record label, UI/Approval tabs, expand, close) — it only
	carries what the chrome does not, and inside the record sheet the pill moves up into
	that chrome. Spacing belongs to the parent Stack, never margins on content.
-->
<Stack gap="md" class={className}>
	{#if title != null || subtitle != null || (actions && !actionsInHeader) || (hasState && !stateInHeader)}
		<Inline align="start" justify="between" gap="md">
			<Inline align="center" gap="sm" class="min-w-0">
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
				{#if !stateInHeader}
					{@render recordState()}
				{/if}
			</Inline>
			{#if actions && !actionsInHeader}
				<Inline gap="sm" shrink={false}>{@render actions()}</Inline>
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
