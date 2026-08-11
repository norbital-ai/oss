<script lang="ts" module>
	/**
	 * The addresses a person can be reached on, as rows rather than as JSON.
	 *
	 * `channels` is a typed list — a transport, an address, and two flags — but it was declared as
	 * plain `json`, so the detail sheet fell through to the structured-value branch and showed a code
	 * editor containing `[]`. That asks an administrator to know the wire shape in order to add a
	 * phone number, and it lets them save a malformed channel that only fails later at delivery.
	 */
	export const CHANNEL_TYPES = [
		'email',
		'phone',
		'wechat',
		'telegram',
		'whatsapp',
		'slack'
	] as const;

	export type ChannelRow = {
		type: (typeof CHANNEL_TYPES)[number];
		address?: string;
		verified?: boolean;
		primary?: boolean;
		[key: string]: unknown;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { humanize } from '@norbital-ai/std/string';
	import { Badge } from '#lib/badge';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

	const { t } = useI18n<UiKeys>();

	let {
		value,
		disabled = false,
		onValueChange,
		class: className
	}: {
		value: unknown;
		disabled?: boolean;
		onValueChange?: (next: unknown) => void;
		class?: string;
	} = $props();

	const typeOptions = CHANNEL_TYPES.map((type) => ({ value: type, label: humanize(type) }));

	const rows = $derived<ChannelRow[]>(
		Array.isArray(value)
			? value.filter((entry): entry is ChannelRow => typeof entry === 'object' && entry !== null)
			: []
	);

	function commit(next: ChannelRow[]): void {
		onValueChange?.(next);
	}

	function update(index: number, patch: Partial<ChannelRow>): void {
		commit(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
	}

	/** Exactly one channel is primary, so electing one demotes the rest rather than adding a second. */
	function electPrimary(index: number): void {
		commit(rows.map((row, position) => ({ ...row, primary: position === index })));
	}

	function addChannel(): void {
		commit([...rows, { type: 'email', address: '', verified: false, primary: rows.length === 0 }]);
	}

	function removeChannel(index: number): void {
		const next = rows.filter((_, position) => position !== index);
		// Removing the primary would leave the record with none; the first survivor inherits it.
		if (rows[index]?.primary && next.length > 0) next[0] = { ...next[0], primary: true };
		commit(next);
	}
</script>

<Stack gap="sm" class={cn('min-w-0', className)}>
	{#each rows as row, index (index)}
		<Inline gap="sm" align="center" class="rounded-md border border-border p-2">
			<Combobox
				options={typeOptions}
				value={row.type}
				ariaLabel={t('dataRenderer.channelType')}
				searchable={false}
				{disabled}
				class="w-36 shrink-0"
				onValueChange={(next) => {
					if (typeof next === 'string') update(index, { type: next as ChannelRow['type'] });
				}}
			/>
			<Input
				value={typeof row.address === 'string' ? row.address : ''}
				placeholder={t('dataRenderer.channelAddress')}
				aria-label={t('dataRenderer.channelAddress')}
				{disabled}
				class="h-9 min-w-0 flex-1"
				oninput={(event) => update(index, { address: event.currentTarget.value })}
			/>
			{#if row.verified}
				<Badge variant="success" class="shrink-0">{t('dataRenderer.channelVerified')}</Badge>
			{/if}
			<Button
				type="button"
				variant={row.primary ? 'default' : 'ghost'}
				size="sm"
				class="shrink-0"
				aria-pressed={row.primary === true}
				{disabled}
				onclick={() => electPrimary(index)}
			>
				{t('dataRenderer.channelPrimary')}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="shrink-0"
				aria-label={t('dataRenderer.channelRemove')}
				{disabled}
				onclick={() => removeChannel(index)}
			>
				<Icon icon="lucide:trash-2" class="size-4" />
			</Button>
		</Inline>
	{:else}
		<p class="text-sm text-muted-foreground">{t('dataRenderer.channelsEmpty')}</p>
	{/each}
	<Inline gap="sm">
		<Button type="button" variant="outline" size="sm" {disabled} onclick={addChannel}>
			<Icon icon="lucide:plus" class="size-4" />
			{t('dataRenderer.channelAdd')}
		</Button>
	</Inline>
</Stack>
