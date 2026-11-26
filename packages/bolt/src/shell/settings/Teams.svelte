<!--
	Settings → Organization → Teams: one row per `sys_team`. A team's name, parent and policies are created and edited in
	this one inline card, whose single footer saves or deletes it.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Cluster, Stack, Surface } from '@norbital-ai/ui/layout';
	import { Button, Combobox, confirm_action, Field, Form, Input, Table, type UiContext } from '@norbital-ai/ui';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from './data.ts';

	let {
		ctx,
		bolt,
		settings,
		t,
		reload
	}: {
		ctx: UiContext;
		bolt: ShellBolt;
		settings: Settings;
		t: (key: string) => string;
		reload: () => Effect.Effect<void>;
	} = $props();

	type Team = Settings['teams'][number];
	const nameOf = (id: string | null) => settings.teams.find((team) => team.id === id)?.name ?? '—';
	const rows = $derived(
		settings.teams.map((team) => ({
			id: team.id,
			name: team.name,
			parent: nameOf(team.parent),
			policies: team.policies.length === 0 ? '—' : team.policies.join(', ')
		}))
	);
	let creating = $state(false);
	let editing = $state<string | null>(null);
	const editing_team = $derived(settings.teams.find((team) => team.id === editing));
	let error = $state<string | null>(null);
	const back = () => {
		creating = false;
		editing = null;
		error = null;
	};
	const saved = (kind: string) => {
		if (kind !== 'committed') return;
		back();
		fork(reload());
	};

	const remove = (team: Team) =>
		fork(
			confirm_action({
				title: t('Delete {name}?').replace('{name}', team.name),
				body: t('A team that a member, an invitation, an API key or another team still names cannot be deleted.'),
				confirm_label: t('Delete'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt.act({ 'sys_team.delete': [{ target: { id: team.id } }] }).pipe(
								Effect.tap((outcome) =>
									Effect.sync(() => {
										if (outcome.kind === 'committed') back();
									})
								),
								Effect.andThen(reload())
							)
						: Effect.void
				)
			),
			(cause) => {
				error = cause.message;
			}
		);
</script>

<!-- `self` is the team being edited: it is no parent of itself -->
{#snippet fields(self: string | null)}
	<Field {ctx} name="name" label={t('Name')}>
		{#snippet editor(field)}
			<Input id={field.id} value={typeof field.value === 'string' ? field.value : ''} disabled={field.disabled}
				oninput={(event) => field.on_change(event.currentTarget.value === '' ? null : event.currentTarget.value)} />
		{/snippet}
	</Field>
	<Field {ctx} name="parent" label={t('Parent team')}>
		{#snippet editor(field)}
			<Combobox id={field.id} aria-label={t('Parent team')} placeholder={t('No parent')}
				options={settings.teams.filter((team) => team.id !== self).map((team) => ({ value: team.id, label: team.name }))}
				value={typeof field.value === 'string' ? field.value : null}
				on_change={field.on_change} disabled={field.disabled} />
		{/snippet}
	</Field>
	<Field {ctx} name="policies" label={t('Policies')}>
		{#snippet editor(field)}
			<Combobox id={field.id} multiple aria-label={t('Policies')} placeholder={t('Choose policies')}
				options={settings.policies.map((policy) => ({ value: policy, label: policy }))}
				value={Array.isArray(field.value) ? field.value.filter((value): value is string => typeof value === 'string') : []}
				on_change={field.on_change} disabled={field.disabled} />
		{/snippet}
	</Field>
{/snippet}

{#if creating || editing_team !== undefined}
	<Surface as="section" data-team={editing_team?.id ?? 'new'}>
		<Stack gap="md">
			<Cluster justify="between">
				<h3 class="text-sm font-medium">{editing_team?.name ?? t('New team')}</h3>
				<Button variant="ghost" onclick={back}>{t('Back to teams')}</Button>
			</Cluster>
			{#if error !== null}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
			{#if editing_team === undefined}
				<Form {ctx} of="sys_team" mode="create" size="content" submit={t('Create team')}
					on_outcome={(outcome) => saved(outcome.kind)}>
					{@render fields(null)}
				</Form>
			{:else}
				{@const team = editing_team}
				<Form {ctx} of="sys_team" mode="update" id={team.id} size="content" submit={t('Save')}
					on_outcome={(outcome) => saved(outcome.kind)}>
					{#snippet children()}{@render fields(team.id)}{/snippet}
					{#snippet actions()}
						<Button variant="outline" onclick={() => remove(team)}>{t('Delete team')}</Button>
					{/snippet}
				</Form>
			{/if}
		</Stack>
	</Surface>
{:else}
	<Table {ctx}
		of={rows}
		columns={[
			{ field: 'name', label: t('Name') },
			{ field: 'parent', label: t('Parent team') },
			{ field: 'policies', label: t('Policies') }
		]}
		key="settings-teams"
		toolbar={{
			title: t('Teams'),
			description: t('A team holds the policies its members act under. A parent scopes data and lends no policy.'),
			select: false,
			export: false,
			delete: false,
			new: () => {
				creating = true;
			}
		}}
		on_open={(row) => (editing = row.id)}
	/>
{/if}
