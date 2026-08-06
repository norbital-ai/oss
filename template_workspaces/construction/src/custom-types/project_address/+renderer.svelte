<script lang="ts">
	import { Input } from '@norbital-ai/ui/input';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Grid } from '@norbital-ai/ui/layout';
	import type { RendererProps, Value } from './$types.js';
	import { projectAddressSchema } from './+definition.js';

	let props: RendererProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(projectAddressSchema.partial().safeParse(props.value));
	const address = $derived(parsed.success ? parsed.data : {});

	function update(patch: Partial<Value>): void {
		if (props.mode !== 'edit') return;
		const next = { ...address, ...patch };
		const hasValue = Object.values(next).some((value) => value != null && value !== '');
		props.onValueChange(hasValue ? next : null);
	}
</script>

<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.address_line_1')}
		<Input
			value={address.line_1 ?? ''}
			{disabled}
			oninput={(event) => update({ line_1: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.address_line_2')}
		<Input
			value={address.line_2 ?? ''}
			{disabled}
			oninput={(event) => update({ line_2: event.currentTarget.value || null })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.city')}
		<Input
			value={address.city ?? ''}
			{disabled}
			oninput={(event) => update({ city: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.state')}
		<Input
			value={address.state ?? ''}
			{disabled}
			oninput={(event) => update({ state: event.currentTarget.value || null })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.postal_code')}
		<Input
			value={address.postal_code ?? ''}
			{disabled}
			oninput={(event) => update({ postal_code: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		{t('component.country')}
		<Input
			value={address.country ?? ''}
			{disabled}
			oninput={(event) => update({ country: event.currentTarget.value })}
		/>
	</label>
</Grid>
