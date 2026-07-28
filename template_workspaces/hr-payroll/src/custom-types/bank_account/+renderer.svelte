<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import type { RendererProps } from './$types.js';
	import { Input } from '@norbital-ai/ui/input';
	import { bankAccountDraftSchema, bankAccountSchema, type BankAccount } from './+definition.js';
	import { Grid } from '@norbital-ai/ui/layout';

	interface BankOption {
		readonly name: string;
		readonly code: string;
	}

	const BANKS: readonly BankOption[] = [
		{ name: 'Maybank', code: 'MBBEMYKL' },
		{ name: 'CIMB Bank', code: 'CIBBMYKL' },
		{ name: 'Public Bank', code: 'PBBEMYKL' },
		{ name: 'RHB Bank', code: 'RHBBMYKL' },
		{ name: 'Hong Leong Bank', code: 'HLBBMYKL' },
		{ name: 'AmBank', code: 'ARBKMYKL' }
	];
	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);

	const parsedIncoming = $derived(bankAccountDraftSchema.safeParse(props.value));
	const incoming = $derived<Partial<BankAccount>>(
		parsedIncoming.success && parsedIncoming.data ? parsedIncoming.data : {}
	);

	/**
	 * All four fields are required, so a half-typed form is not a `Value`. The partial draft is held
	 * locally and pushed upward only once it parses complete — clearing to `null` when emptied.
	 */
	let draft = $state<Partial<BankAccount>>({});
	const account = $derived({ ...incoming, ...draft });
	const availableBanks = $derived(BANKS);
	const bankOptions = $derived(
		availableBanks.map((bank) => ({
			value: bank.code,
			label: bank.name,
			description: bank.code,
			search_term: `${bank.name} ${bank.code}`
		}))
	);

	function emit(next: BankAccount | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function update(patch: Partial<BankAccount>): void {
		draft = { ...draft, ...patch };
		const next = { ...incoming, ...draft };
		if (!Object.values(next).some((entry) => entry?.trim())) {
			emit(null);
			return;
		}
		const complete = bankAccountSchema.safeParse(next);
		if (complete.success) emit(complete.data);
	}
</script>

<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
	<label class="grid gap-1.5 text-sm font-medium">
		Bank
		{#if bankOptions.length > 0}
			<Combobox
				options={bankOptions}
				value={account.bank_code ?? null}
				{disabled}
				searchPlaceholder="Search banks…"
				emptyPlaceholder="No bank selected"
				onValueChange={(code) => {
					const selected = availableBanks.find((bank) => bank.code === code);
					if (selected) update({ bank_name: selected.name, bank_code: selected.code });
				}}
			/>
		{:else}
			<Input
				value={account.bank_name ?? ''}
				{disabled}
				placeholder="Bank name"
				oninput={(event) => update({ bank_name: event.currentTarget.value })}
			/>
		{/if}
	</label>
	{#if bankOptions.length === 0}
		<label class="grid gap-1.5 text-sm font-medium">
			Bank code
			<Input
				value={account.bank_code ?? ''}
				{disabled}
				placeholder="SWIFT or routing code"
				oninput={(event) => update({ bank_code: event.currentTarget.value })}
			/>
		</label>
	{/if}
	<label class="grid gap-1.5 text-sm font-medium">
		Account holder
		<Input
			value={account.bank_account_name ?? ''}
			{disabled}
			autocomplete="name"
			placeholder="Registered account name"
			oninput={(event) => update({ bank_account_name: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		Account number
		<Input
			value={account.bank_account_number ?? ''}
			{disabled}
			inputmode="numeric"
			autocomplete="off"
			placeholder="Bank account number"
			oninput={(event) => update({ bank_account_number: event.currentTarget.value })}
		/>
	</label>
</Grid>
