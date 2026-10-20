<script lang="ts">
	import { AccessFrame } from '@norbital-ai/ui/brand';

	let mode = $state<'choose' | 'create' | 'long'>('choose');
	let created = $state(false);
	const labels = {
		switchLanguage: 'Change language',
		lightMode: 'Use light theme',
		darkMode: 'Use dark theme',
		secureAccess: 'Secure access'
	};
</script>

<nav aria-label="Fixture content" class="fixture-controls">
	<button type="button" data-mode="choose" onclick={() => (mode = 'choose')}>Show workspaces</button
	>
	<button type="button" data-mode="create" onclick={() => (mode = 'create')}
		>Show create form</button
	>
	<button type="button" data-mode="long" onclick={() => (mode = 'long')}>Show long form</button>
</nav>

<AccessFrame language="中文" onLanguage={() => {}} dark={false} onTheme={() => {}} {labels}>
	<div class="fixture-content">
		<header>
			<h1>{mode === 'choose' ? 'Choose a workspace' : 'Create a workspace'}</h1>
			<p>
				{mode === 'choose'
					? 'Continue with an existing workspace.'
					: 'Enter your organisation details.'}
			</p>
		</header>
		{#if mode === 'choose'}
			<button type="button">Acme Operations</button>
			<button type="button">Norbital</button>
		{:else}
			<form
				onsubmit={(event) => {
					event.preventDefault();
					created = true;
				}}
			>
				{#each mode === 'long' ? Array.from({ length: 16 }, (_, index) => `Organisation detail ${index + 1}`) : ['Organisation name', 'Workspace address', 'Region'] as label (label)}
					<label>{label}<input type="text" /></label>
				{/each}
				<button type="submit">Create workspace</button>
				{#if created}<p role="status">Workspace created</p>{/if}
			</form>
		{/if}
	</div>
	{#snippet footer()}
		<p class="access-switch"><a href="#workspaces">Change workspace</a></p>
	{/snippet}
</AccessFrame>

<style>
	.fixture-controls {
		position: fixed;
		inset: 0 auto auto 0;
		z-index: 50;
		display: flex;
		gap: 0.5rem;
		font-size: 0.75rem;
	}
	.fixture-content,
	form,
	label {
		display: grid;
		gap: 1rem;
	}
	label {
		gap: 0.375rem;
		font-size: 0.875rem;
	}
	h1 {
		font-size: 1.25rem;
		font-weight: 600;
	}
	header p {
		font-size: 0.875rem;
	}
	.fixture-content button,
	input {
		min-height: 2.75rem;
		border: 1px solid var(--border);
		border-radius: 0.25rem;
		padding: 0.5rem;
	}
</style>
