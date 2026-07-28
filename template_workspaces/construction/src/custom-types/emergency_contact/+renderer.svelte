<script lang="ts">
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import type { RendererProps, Value } from './$types.js';
	import { emergencyContactSchema } from './+definition.js';

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(emergencyContactSchema.partial().safeParse(props.value));
	const contact = $derived(parsed.success ? parsed.data : {});

	function update(patch: Partial<Value>): void {
		if (props.mode !== 'edit') return;
		const next = { ...contact, ...patch };
		const hasValue = Object.values(next).some((value) => value != null && value !== '');
		props.onValueChange(hasValue ? next : null);
	}
</script>

<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
	<label class="grid gap-1.5 text-sm font-medium">
		Name
		<Input
			value={contact.name ?? ''}
			{disabled}
			autocomplete="name"
			oninput={(event) => update({ name: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		Phone
		<Input
			value={contact.phone ?? ''}
			{disabled}
			type="tel"
			autocomplete="tel"
			oninput={(event) => update({ phone: event.currentTarget.value })}
		/>
	</label>
	<label class="grid gap-1.5 text-sm font-medium">
		Relationship
		<Input
			value={contact.relationship ?? ''}
			{disabled}
			oninput={(event) => update({ relationship: event.currentTarget.value || null })}
		/>
	</label>
</Grid>
