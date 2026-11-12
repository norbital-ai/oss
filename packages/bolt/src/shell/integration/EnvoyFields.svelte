<script lang="ts">
	import { Combobox, Field, Input, Textarea } from '@norbital-ai/ui';
	let { policies, t, on_name_change, active = false }: {
		policies: readonly string[];
		t: (key: string) => string;
		on_name_change?: (name: string) => void;
		active?: boolean;
	} = $props();
</script>

<Field name="name" label={t('Name')}>
	{#snippet editor(field)}
		<Input id={field.id} value={typeof field.value === 'string' ? field.value : ''} disabled={field.disabled}
			oninput={(event) => { const name = event.currentTarget.value; field.on_change(name === '' ? null : name); on_name_change?.(name); }} />
	{/snippet}
</Field>
<Field name="audience" label={t('Audience')} />
<Field name="task" label={t('Instructions')}>
	{#snippet editor(field)}
		<Textarea id={field.id} rows={4} value={typeof field.value === 'string' ? field.value : ''} disabled={field.disabled}
			oninput={(event) => field.on_change(event.currentTarget.value)} />
	{/snippet}
</Field>
<Field name="policies" label={t('Policies')}>
	{#snippet editor(field)}
		<Combobox id={field.id} multiple aria-label={t('Policies')} placeholder={t('Choose policies')}
			options={policies.map((policy) => ({ value: policy, label: policy }))}
			value={Array.isArray(field.value) ? field.value.filter((value): value is string => typeof value === 'string') : []}
			on_change={field.on_change} disabled={field.disabled} />
	{/snippet}
</Field>
<div class="grid gap-3 sm:grid-cols-2">
	<Field name="group_messages" label={t('Group messages')} />
	<Field name="delegation" label={t('Delegation')} />
	<Field name="dm" label={t('Direct messages')} />
	<Field name="triage" label={t('Smart message handling')} />
</div>
{#if active}<Field name="active" label={t('Active')} />{/if}
