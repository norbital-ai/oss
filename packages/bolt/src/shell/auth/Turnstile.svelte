<!--
	The Turnstile widget of a visitor page (§5.10, GAPS r5 11). Each token is single-use: the queue hands one to the next
	upload or final act and re-arms the widget. The dev site key never calls Cloudflare: it issues `dev-pass`.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChallengeQueue } from '../runtime.ts';

	let { site_key, queue }: { site_key: string; queue: ChallengeQueue } = $props();
	let el = $state<HTMLElement | null>(null);

	onMount(() => {
		if (site_key === 'dev') {
			queue.setReset(() => queue.put('dev-pass'));
			queue.put('dev-pass');
			return;
		}
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		script.async = true;
		script.onload = () => {
			const ts = window.turnstile;
			if (ts === undefined || el === null) return;
			const id = ts.render(el, { sitekey: site_key, callback: (token) => queue.put(token) });
			queue.setReset(() => ts.reset(id));
		};
		document.head.append(script);
		return () => script.remove();
	});
</script>

<div bind:this={el} class="flex justify-center p-2"></div>
