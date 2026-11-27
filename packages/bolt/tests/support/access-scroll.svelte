<script lang="ts">
	import { AccessCard, AccessFrame } from '@norbital-ai/ui/brand';
	import { Button, Input } from '@norbital-ai/ui';
	import { Cluster, Scroll, Stack } from '@norbital-ai/ui/layout';

	let { count = 12, fillOnly = false }: { count?: number; fillOnly?: boolean } = $props();
	const items = $derived(Array.from({ length: count }, (_, index) => `Template ${index + 1}`));
</script>

{#if fillOnly}
	<div style="height: 200px; display: flex; flex-direction: column;">
		<Scroll name="Fill list" size="fill" data-testid="fill-scroll">
			{#each items as item (item)}
				<div style="height: 60px;">{item}</div>
			{/each}
		</Scroll>
	</div>
{:else}
	<AccessFrame
		wide
		home="/"
		languages={[{ code: 'en', label: 'English' }]}
		locale="en"
		on_locale={() => {}}
		dark={false}
		on_theme={() => {}}
		labels={{
			switchLanguage: 'Switch language',
			lightMode: 'Light mode',
			darkMode: 'Dark mode',
			secureAccess: 'Secure access'
		}}
	>
		<AccessCard
			eyebrow="Step 1 of 4"
			title="Choose a template"
			wide
			hint="Your workspace starts from it: its models, apps and automations."
		>
			<Cluster gap="sm" data-testid="search-bar">
				<Input type="search" class="min-w-0 flex-1" placeholder="Search templates" />
			</Cluster>
			<form id="signup-step" data-access-scroll>
				<Scroll
					name="Template"
					max="compact"
					data-testid="template-scroll"
					class={items.length > 1 ? 'min-h-[8rem]' : undefined}
				>
					<Stack as="fieldset" gap="sm">
						{#each items as item (item)}
							<div
								data-testid="template-row"
								class="rounded-md border border-border p-2"
								style="height: 84px;"
							>
								{item}
							</div>
						{/each}
					</Stack>
				</Scroll>
			</form>
			<p class="access-error text-sm text-destructive" role="alert"></p>
			<Button type="submit" form="signup-step" class="access-action w-full" data-testid="continue">
				Continue
			</Button>
			<a href="/select" class="text-center text-sm text-muted-foreground underline">
				Select workspace
			</a>
		</AccessCard>
	</AccessFrame>
{/if}
