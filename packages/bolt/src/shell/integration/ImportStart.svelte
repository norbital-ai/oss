<script lang="ts">
	import { Combobox, Input } from '@norbital-ai/ui';
	import type { ImportStartInput, ProviderChoice } from '../../protocol/instance-status.ts';
	import { importDate } from './import-start.ts';
	import { sayOf } from './setup.ts';

	let {
		provider,
		value,
		onChange,
		busy = false,
		t,
		locale
	}: {
		provider: ProviderChoice;
		value: ImportStartInput;
		onChange: (value: ImportStartInput) => void;
		busy?: boolean;
		t: (key: string) => string;
		locale?: string | undefined;
	} = $props();
	const say = $derived(sayOf(t, locale));
	const timeZone = $derived(
		value.kind === 'now' || value.kind === 'since'
			? value.zone
			: Intl.DateTimeFormat().resolvedOptions().timeZone
	);
	function choose(kind: string | null): void {
		if (kind === 'all') onChange({ kind });
		else if (kind === 'now') onChange({ kind, zone: timeZone });
		else if (kind === 'since') {
			let date = new Date().toISOString().slice(0, 10);
			try {
				date = importDate(new Date().toISOString(), timeZone);
			} catch {
				/* The zone stays editable; Connect waits for a valid one. */
			}
			onChange({ kind, date: value.kind === 'since' ? value.date : date, zone: timeZone });
		}
	}
	function native(name: string, content: string): void {
		if (value.kind === 'native')
			onChange({ ...value, values: { ...value.values, [name]: content } });
	}
</script>

{#if provider.importStart !== undefined}
	<fieldset class="flex min-w-0 flex-col gap-3" disabled={busy} data-import-start>
		<legend class="mb-2 text-sm font-medium">{t('Import start')}</legend>
		{#if provider.importStart.kind === 'timestamp'}
			<Combobox
				size="sm"
				aria-label={t('Import start')}
				disabled={busy}
				value={value.kind}
				onChange={choose}
				options={[
					{ value: 'now', label: t('From now') },
					{ value: 'since', label: t('Since a chosen date') },
					{ value: 'all', label: t('All available history') }
				]}
			/>
			{#if value.kind === 'since'}
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-label">{t('Start date')}</span>
					<Input
						type="date"
						name="import-start-date"
						required
						value={value.date}
						oninput={(event) =>
							value.kind === 'since' && onChange({ ...value, date: event.currentTarget.value })}
					/>
				</label>
			{/if}
			{#if value.kind === 'since' || value.kind === 'now'}
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-label">{t('Time zone')}</span>
					<Input
						name="import-start-zone"
						required
						value={timeZone}
						oninput={(event) =>
							(value.kind === 'since' || value.kind === 'now') &&
							onChange({ ...value, zone: event.currentTarget.value })}
					/>
				</label>
				<p class="text-meta">
					{value.kind === 'since'
						? t('The chosen date starts at midnight in this IANA time zone.')
						: provider.importStart.precision === 'second'
							? t('The import start is saved when you connect or apply.')
							: t('The host saves the current instant when you connect or apply.')}
				</p>
				{#if value.kind === 'now' && provider.importStart.precision === 'second'}
					<p class="text-meta" data-import-start-precision>
						{t(
							'This source timestamps messages to the second; the whole starting second is included.'
						)}
					</p>
				{/if}
				<p class="text-meta">
					{t('Messages without a source timestamp are skipped while an import start is set.')}
				</p>
			{/if}
		{:else if value.kind === 'native'}
			{#each provider.importStart.fields as field (field.name)}
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-label">{say(field.label)}</span>
					{#if field.options !== undefined}
						<Combobox
							size="sm"
							disabled={busy}
							aria-label={say(field.label)}
							value={value.values[field.name] ?? field.options[0]?.value ?? null}
							onChange={(selected) => selected !== null && native(field.name, selected)}
							options={field.options.map((option) => ({
								value: option.value,
								label: say(option.label)
							}))}
						/>
					{:else}
						<Input
							name={field.name}
							type={field.secret === true ? 'password' : 'text'}
							required={field.optional !== true}
							value={value.values[field.name] ?? ''}
							oninput={(event) => native(field.name, event.currentTarget.value)}
						/>
					{/if}
					{#if field.hint !== undefined}<span class="text-meta">{say(field.hint)}</span>{/if}
				</label>
			{/each}
		{/if}
	</fieldset>
{/if}
