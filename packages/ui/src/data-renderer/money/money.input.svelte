<script lang="ts">
	import { currencyFractionDigits, ISO_CURRENCY } from '@norbital-ai/std/finance';
	import Icon from '@iconify/svelte';
	import { Button, buttonVariants } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import * as InputGroup from '#lib/input-group';
	import { Inline, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';

	export interface MoneyValue {
		value: number;
		currency: string;
	}

	interface MoneyDraft {
		amount: string;
		currency: string;
	}

	const { t } = useI18n<UiKeys>();

	let {
		value,
		id,
		currencies,
		multiple = false,
		disabled = false,
		class: className,
		onValueChange
	}: {
		value: MoneyValue | MoneyValue[] | null;
		id?: string;
		currencies?: readonly string[];
		multiple?: boolean;
		disabled?: boolean;
		class?: string;
		onValueChange?: (value: MoneyValue | MoneyValue[] | null) => void;
	} = $props();

	const defaultCurrency = $derived(currencies?.[0] ?? 'USD');
	const currencyOptions = $derived(
		(currencies?.length
			? ISO_CURRENCY.filter((currency) => currencies.includes(currency.code))
			: ISO_CURRENCY
		).map((currency) => ({
			value: currency.code,
			label: `${currency.flag} ${currency.code}`,
			search_term: `${currency.code} ${currency.name} ${currency.country}`
		}))
	);
	let drafts = $state<MoneyDraft[]>([]);
	let focusedIndex = $state<number | null>(null);
	let open = $state(false);

	watch(
		() => value,
		(next) => {
			const values = Array.isArray(next) ? next : next ? [next] : [];
			drafts = values.length
				? values.map((entry, index) => {
						const current = drafts[index];
						return focusedIndex === index &&
							current?.currency === entry.currency &&
							Number(current.amount) === entry.value
							? current
							: { amount: String(entry.value), currency: entry.currency };
					})
				: multiple
					? []
					: [{ amount: '', currency: defaultCurrency }];
		},
		{ lazy: false }
	);

	const completedValues = $derived(
		drafts.flatMap((draft) => {
			const amount = Number(draft.amount);
			return draft.amount.trim() && Number.isFinite(amount) && draft.currency
				? [{ value: amount, currency: draft.currency }]
				: [];
		})
	);
	const triggerText = $derived(
		completedValues.length
			? completedValues.map((entry) => formatMoney(entry)).join(', ')
			: multiple
				? t('dataRenderer.noAmountsSelected')
				: t('dataRenderer.selectAmount')
	);

	function formatMoney(entry: MoneyValue): string {
		return `${entry.currency} ${entry.value.toLocaleString(undefined, {
			minimumFractionDigits: currencyFractionDigits(entry.currency),
			maximumFractionDigits: currencyFractionDigits(entry.currency)
		})}`;
	}

	function amountPlaceholder(currency: string): string {
		const digits = currencyFractionDigits(currency);
		return digits === 0 ? '0' : `0.${'0'.repeat(digits)}`;
	}

	function displayedAmount(draft: MoneyDraft, index: number): string {
		if (focusedIndex === index || !draft.amount.trim()) return draft.amount;
		const amount = Number(draft.amount);
		if (!Number.isFinite(amount)) return draft.amount;
		return amount.toLocaleString(undefined, {
			minimumFractionDigits: currencyFractionDigits(draft.currency),
			maximumFractionDigits: currencyFractionDigits(draft.currency)
		});
	}

	function emit(next: MoneyDraft[]): void {
		drafts = next;
		const completed = next.flatMap((draft) => {
			const amount = Number(draft.amount);
			return draft.amount.trim() && Number.isFinite(amount) && draft.currency
				? [{ value: amount, currency: draft.currency }]
				: [];
		});
		onValueChange?.(multiple ? completed : (completed[0] ?? null));
	}

	function updateCurrency(index: number, currency: string | null): void {
		if (!currency) return;
		emit(drafts.map((draft, itemIndex) => (itemIndex === index ? { ...draft, currency } : draft)));
	}

	function updateAmount(index: number, input: string): void {
		const draft = drafts[index];
		if (!draft) return;
		const digits = currencyFractionDigits(draft.currency);
		const clean = input
			.replace(/[^\d.-]/g, '')
			.replace(/(?!^)-/g, '')
			.replace(/(\..*)\./g, '$1');
		const [whole, fraction] = clean.split('.');
		const amount =
			fraction == null || digits === 0 ? whole : `${whole}.${fraction.slice(0, digits)}`;
		emit(drafts.map((entry, itemIndex) => (itemIndex === index ? { ...entry, amount } : entry)));
	}

	function addValue(): void {
		drafts = [...drafts, { amount: '', currency: defaultCurrency }];
	}

	function removeValue(index: number): void {
		emit(drafts.filter((_, itemIndex) => itemIndex !== index));
	}
</script>

{#snippet moneyFields()}
	{#if multiple && drafts.length === 0}
		<Stack gap="sm" align="center" class="rounded-md border border-dashed p-5 text-center">
			<Icon icon="lucide:banknote" class="size-8 text-muted-foreground" />
			<p class="text-sm font-medium">{t('dataRenderer.noAmountsConfigured')}</p>
			<p class="text-xs text-muted-foreground">{t('dataRenderer.addMonetaryValue')}</p>
		</Stack>
	{/if}

	{#each drafts as draft, index (index)}
		<Inline gap="sm" class="min-w-0">
			<InputGroup.Root class="min-w-0 w-full flex-1 overflow-hidden">
				<InputGroup.Addon align="inline-start" class="border-r border-input pr-1">
					<Combobox
						options={currencyOptions}
						value={draft.currency}
						emptyPlaceholder="CCY"
						searchable={currencyOptions.length > 8}
						{disabled}
						class="w-20"
						triggerClass="h-7 max-w-full border-0 bg-transparent px-1 shadow-none hover:bg-muted focus-visible:ring-0"
						minWidth={220}
						onValueChange={(currency) => updateCurrency(index, currency)}
					/>
				</InputGroup.Addon>
				<InputGroup.Input
					type="text"
					inputmode="decimal"
					class="min-w-0"
					placeholder={amountPlaceholder(draft.currency)}
					value={displayedAmount(draft, index)}
					{disabled}
					onfocus={() => (focusedIndex = index)}
					onblur={() => (focusedIndex = null)}
					oninput={(event) => updateAmount(index, event.currentTarget.value)}
				/>
			</InputGroup.Root>

			{#if multiple}
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('dataRenderer.removeAmount')}
					{disabled}
					onclick={() => removeValue(index)}
				>
					<Icon icon="lucide:x" class="size-4" />
				</Button>
			{/if}
		</Inline>
	{/each}

	{#if multiple}
		<Button
			variant="outline"
			class="w-full justify-center border-dashed"
			{disabled}
			onclick={addValue}
		>
			<Icon icon="lucide:plus" class="size-4" />
			{t('dataRenderer.addAmount')}
		</Button>
	{/if}
{/snippet}

{#if multiple}
	<div class="w-full min-w-0">
		<Popover.Root bind:open>
			<Popover.Trigger
				{id}
				class={cn(
					buttonVariants({ variant: 'outline' }),
					'group h-9 w-full min-w-0 justify-start gap-2 overflow-hidden px-3',
					className
				)}
				{disabled}
			>
				<Icon
					icon="lucide:banknote"
					class={cn(
						'size-4 shrink-0',
						completedValues.length ? 'text-emerald-600' : 'text-muted-foreground'
					)}
				/>
				<span class="min-w-0 flex-1 truncate text-left text-sm">{triggerText}</span>
				<Icon icon="lucide:chevrons-up-down" class="size-4 shrink-0 text-muted-foreground" />
			</Popover.Trigger>

			<Popover.Content sameWidth={true} minWidth={360} align="start" class="p-3">
				<Stack gap="sm">{@render moneyFields()}</Stack>
			</Popover.Content>
		</Popover.Root>
	</div>
{:else}
	<div {id} class={cn('w-full min-w-0', className)}>
		{@render moneyFields()}
	</div>
{/if}
