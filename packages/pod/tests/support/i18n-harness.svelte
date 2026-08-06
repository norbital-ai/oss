<script lang="ts">
	import { provideI18n } from '@norbital-ai/ui/i18n';
	import { uiMessages } from '@norbital-ai/ui/i18n';
	import type { Component } from 'svelte';
	import { podMessages } from '$lib/i18n/index.js';

	/**
	 * The i18n provider, and nothing else.
	 *
	 * The pod chrome components translate through `useI18n<PodUiKeys>()`, which falls back to the
	 * `@norbital-ai/ui` catalog when no provider is installed — and that catalog has no `pod.*`
	 * keys, so a pod chrome component mounted bare would render raw keys. Standing up the merged
	 * pod + ui catalog here is what makes `render` in `component.ts` see the English copy a tenant
	 * sees.
	 */
	let {
		component: Subject,
		props
	}: {
		component: Component<Record<string, unknown>, Record<string, unknown>, string>;
		props: Record<string, unknown>;
	} = $props();

	provideI18n({
		en: { ...uiMessages.en, ...podMessages.en },
		zh: { ...uiMessages.zh, ...podMessages.zh }
	});
</script>

<Subject {...props} />
