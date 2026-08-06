<script lang="ts">
	import { Input } from '@norbital-ai/ui/input';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import type { z } from 'zod';
	import type { RendererProps } from './$types.js';
	import { permitSignaturesSchema } from './+definition.js';

	type PermitSignatures = z.infer<typeof permitSignaturesSchema>;
	type SignatureRole = keyof PermitSignatures;
	type Signature = NonNullable<PermitSignatures[SignatureRole]>;

	const { t } = useI18n<TenantI18nKeys>();

	const roles = $derived([
		{ key: 'applicant', label: t('component.applicant') },
		{ key: 'issuer', label: t('component.issuer') },
		{ key: 'acceptor', label: t('component.acceptor') }
	] satisfies readonly { key: SignatureRole; label: string }[]);

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(permitSignaturesSchema.safeParse(props.value));
	const signatures = $derived(
		parsed.success ? parsed.data : { applicant: null, issuer: null, acceptor: null }
	);

	function update(role: SignatureRole, patch: Partial<Signature>): void {
		if (props.mode !== 'edit') return;
		const current = signatures[role] ?? { name: '', date: '' };
		const signature = { ...current, ...patch };
		const next = {
			...signatures,
			[role]: signature.name || signature.date ? signature : null
		};
		props.onValueChange(Object.values(next).some((value) => value != null) ? next : null);
	}
</script>

<Grid gap="sm" minimum="panel">
	{#each roles as role (role.key)}
		<Stack class="rounded-md border border-border bg-muted/20 p-3" gap="sm">
			<p class="text-sm font-semibold">{role.label}</p>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('component.name')}
				<Input
					value={signatures[role.key]?.name ?? ''}
					{disabled}
					oninput={(event) => update(role.key, { name: event.currentTarget.value })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('component.date')}
				<Input
					type="date"
					value={signatures[role.key]?.date ?? ''}
					{disabled}
					oninput={(event) => update(role.key, { date: event.currentTarget.value })}
				/>
			</label>
		</Stack>
	{/each}
</Grid>
