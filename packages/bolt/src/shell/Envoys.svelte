<script lang="ts">
	import { Button, Checkbox, Combobox, Dialog, Input, Table, Textarea } from '@norbital-ai/ui';
	import type { Settings } from './data.ts';
	import type { ShellApi } from './runtime.ts';

	type EnvoyAudience = 'private' | 'public';
	type EnvoyGroupMessages = 'disabled' | 'mention_or_reply' | 'all';
	type EnvoyTriageScope = 'all' | 'dm' | 'group';
	type EnvoyForm = {
		id: string; name: string; task: string; audience: EnvoyAudience; policies: string[]; channels: string[];
		groupMessages: EnvoyGroupMessages; delegation: 'disabled' | 'enabled'; active: boolean; triage: boolean; triageScope: EnvoyTriageScope;
	};
	const empty = (): EnvoyForm => ({ id: '', name: '', task: '', audience: 'private', policies: [], channels: [], groupMessages: 'disabled', delegation: 'disabled', active: true, triage: false, triageScope: 'all' });

	let { settings, api, t, onSaved, onConnection }: { settings: Settings; api: ShellApi; t: (s: string) => string; onSaved(): Promise<void>; onConnection(id: string): void } = $props();
	let open = $state(false), busy = $state(false), error = $state<string | null>(null);
	let form = $state(empty());
	const rows = $derived(settings.envoys.map((e) => ({ ...e, connections: e.channels.map((id) => settings.channels.find((c) => c.name === id)?.label ?? id).join(', '), status: t(e.active ? 'active' : 'paused') })));
	function edit(id?: string): void {
		const e = settings.envoys.find((e) => e.id === id);
		if (e === undefined) form = empty();
		else {
			const scope = typeof e.triage === 'object' && e.triage !== null && 'scope' in e.triage ? e.triage['scope'] : 'all';
			const triageScope: EnvoyTriageScope = scope === 'dm' || scope === 'group' ? scope : 'all';
			form = { id: e.id, name: e.name, task: e.task, audience: e.audience, policies: [...e.policies], channels: [...e.channels], groupMessages: e.group_messages, delegation: e.delegation, active: e.active, triage: e.triage !== false, triageScope };
		}
		error = null; open = true;
	}
	const toggle = (values: string[], id: string, on: boolean) => on ? [...values, id] : values.filter((v) => v !== id);
	async function save(remove = false): Promise<void> {
		busy = true; error = null;
		try {
			const { id, triageScope, ...values } = form;
			const r = await api.settingsOp(remove ? 'deleteEnvoy' : 'saveEnvoy', remove ? { id: form.id } : { ...values, ...(id ? { id } : {}), triage: form.triage ? { scope: triageScope } : false });
			if (!r.ok) { error = r.error.message; return; }
			await onSaved(); open = false;
		} finally { busy = false; }
	}
</script>

<Table of={rows} key="envoys" onOpen={(row) => edit(row.id)} toolbar={{ description: t('Configure an envoy and connect the accounts it answers through.'), new: () => edit() }}
	columns={[{ field: 'name', label: t('Name') }, { field: 'connections', label: t('Channel connections') }, { field: 'audience', label: t('Audience') }, { field: 'status', label: t('Status') }]}>
	{#snippet empty()}<p class="text-sm text-muted-foreground">{t('Create an envoy, then attach one or more workspace channel connections.')}</p>{/snippet}
</Table>
<Dialog.Root {open} onOpenChange={(value) => { if (!busy) open = value; }}>
	<Dialog.Content class="max-w-xl">
		<Dialog.Header><Dialog.Title>{t(form.id ? 'Configure envoy' : 'Create envoy')}</Dialog.Title></Dialog.Header>
		<form class="flex flex-col gap-4" onsubmit={(e) => { e.preventDefault(); void save(); }}>
			<label class="flex flex-col gap-1">{t('Name')}<Input required bind:value={form.name} /></label>
			<label class="flex flex-col gap-1">{t('Instructions')}<Textarea maxlength={32000} bind:value={form.task} /></label>
			<label class="flex flex-col gap-1">{t('Audience')}
				<Combobox size="sm" aria-label={t('Audience')} value={form.audience} onChange={(v) => { if (v !== null) form.audience = v; }}
					options={[{ value: 'private', label: t('Private — recognised members') }, { value: 'public', label: t('Public — anyone') }]} />
			</label>
			<fieldset class="flex flex-col gap-2"><legend>{t('Policies')}</legend>
				{#each settings.policies as policy}<label class="flex items-center gap-2"><Checkbox checked={form.policies.includes(policy)} onCheckedChange={(on) => form.policies = toggle(form.policies, policy, on === true)} />{policy}</label>{/each}
			</fieldset>
			<fieldset class="flex flex-col gap-2"><legend>{t('Channel connections')}</legend>
				{#each settings.channels.filter((c) => c.owner === null) as c}
					{@const attached = settings.envoys.find((e) => e.id !== form.id && e.channels.includes(c.name))}
					<div class="flex items-center justify-between gap-2"><label class="flex items-center gap-2"><Checkbox disabled={attached !== undefined} checked={form.channels.includes(c.name)} onCheckedChange={(on) => form.channels = toggle(form.channels, c.name, on === true)} />{c.label}{#if attached} · {attached.name}{/if}</label>
						<Button size="sm" variant="outline" onclick={() => { open = false; onConnection(c.name); }}>{t('Configure connection')}</Button>
					</div>
				{:else}<p class="text-sm text-muted-foreground">{t('Create a channel connection in Integrations first.')}</p>{/each}
			</fieldset>
			<label class="flex flex-col gap-1">{t('Group messages')}
				<Combobox size="sm" aria-label={t('Group messages')} value={form.groupMessages} onChange={(v) => { if (v !== null) form.groupMessages = v; }}
					options={[{ value: 'disabled', label: t('Disabled') }, { value: 'mention_or_reply', label: t('Mentions and replies') }, { value: 'all', label: t('All messages') }]} />
			</label>
			<label class="flex items-center gap-2"><Checkbox checked={form.delegation === 'enabled'} onCheckedChange={(on) => form.delegation = on ? 'enabled' : 'disabled'} />{t('Allow delegation')}</label>
			<label class="flex items-center gap-2"><Checkbox bind:checked={form.active} />{t('Active')}</label>
			<label class="flex items-center gap-2"><Checkbox bind:checked={form.triage} />{t('Triage messages')}</label>
			{#if form.triage}<label class="flex flex-col gap-1">{t('Triage scope')}
					<Combobox size="sm" aria-label={t('Triage scope')} value={form.triageScope} onChange={(v) => { if (v !== null) form.triageScope = v; }}
						options={[{ value: 'all', label: t('All messages') }, { value: 'dm', label: t('Direct messages') }, { value: 'group', label: t('Group messages') }]} />
				</label>{/if}
			{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
			<Dialog.Footer>{#if form.id}<Button variant="outline" disabled={busy} onclick={() => void save(true)}>{t('Delete envoy')}</Button>{/if}<Button variant="outline" disabled={busy} onclick={() => open = false}>{t('Cancel')}</Button><Button type="submit" disabled={busy || form.policies.length === 0}>{t('Save')}</Button></Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
