<script lang="ts">
	import { getContext } from 'svelte';
	import type { ViewBolt } from '../src/client/contract.js';
	import type { FormState } from '../src/form/form-state.svelte.js';
	import type { RecordView } from '../src/record/types.js';
	import type { FooterFixtureOptions } from './record-footer-harness.svelte';
	import Form from '../src/form/form.svelte';
	import Button from '../src/primitives/button/button.svelte';
	import RecordShell from '../src/record/RecordShell.svelte';

	let { view }: { view: RecordView; ctx: ViewBolt } = $props();
	const fixture = getContext<FooterFixtureOptions>('test.record.footer');
	const id = $derived(view.mode === 'create' ? undefined : view.record.id);
</script>

{#snippet formActions(form: FormState)}
	{#if form.mode !== 'view'}
		<Button type="submit" onclick={fixture.on_form_action} data-form-action>Submit inside form</Button>
	{/if}
{/snippet}

{#snippet nativeActions()}
	<Button variant="outline" onclick={fixture.on_native_action} data-native-action>Native action</Button>
{/snippet}

{#snippet detail()}
	<!-- A normal authored h-full/min-height body must never push native chrome beyond the viewport. -->
	<div style="height:100%;min-height:1600px" data-long-detail>
		<p>Authored record detail</p>
		<Form
			of={view.model}
			{id}
			mode={view.mode === 'create' ? 'create' : 'update'}
			values={view.mode === 'create' ? view.values : undefined}
			fields={['title', 'crew']}
			submit="Create named job"
			actions={fixture.form_actions ? formActions : undefined}
		/>
		{#if fixture.independent_form}
			<Form of="notes" mode="create" fields={['title']} submit="Create independent note" />
		{/if}
		{#each Array.from({ length: 40 }, (_, i) => i + 1) as row (row)}
			<p>Detail row {row}</p>
		{/each}
		<p data-detail-end>End of authored detail</p>
	</div>
{/snippet}

{#snippet extraTab()}
	<div style="height:100%;min-height:1600px" data-extra-detail>
		<p>Extra authored tab</p>
		{#each Array.from({ length: 40 }, (_, i) => i + 1) as row (row)}
			<p>Extra detail row {row}</p>
		{/each}
		<p data-extra-end>End of extra detail</p>
	</div>
{/snippet}

{#if fixture.representation === 'raw'}
	{@render detail()}
{:else}
	<RecordShell
		of={view.model}
		{id}
		mode={view.mode}
		values={view.mode === 'create' ? view.values : undefined}
		title="Authored job"
		subtitle="Represented record"
		lock={fixture.lock}
		footer="Authored footer"
		footer_actions={nativeActions}
		tabs={[{ name: 'extra', title: 'Extra detail', body: extraTab }]}
	>
		{#snippet children()}{@render detail()}{/snippet}
	</RecordShell>
{/if}
