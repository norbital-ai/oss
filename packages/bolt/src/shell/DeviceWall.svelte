<!--
	The device wall (`requires` on an app): until every permission the app declares is granted on this device, the app's
	pages are replaced by what is missing, why, and the one way to allow it — the browser's prompt, or the phone's
	settings once refused. Rechecked every few seconds and whenever the page comes back, so returning from Settings opens
	the app without a reload.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Badge, Button, Icon } from '@norbital-ai/ui';
	import { Center, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { DeviceRequirement } from '../decl/runtime/app.ts';
	import type { Device, DeviceState } from './device.ts';

	let { requires, device, native, t, children }: {
		requires: readonly DeviceRequirement[]; device: Device; native: boolean; t: (key: string) => string; children: Snippet;
	} = $props();

	const COPY: { [R in DeviceRequirement]: { icon: string; label: string; why: string } } = $derived({
		location: { icon: 'lucide:map-pin', label: 'Location', why: 'This app uses where you are while it is open.' },
		'location:background': { icon: 'lucide:navigation', label: 'Location, always',
			why: native ? 'Choose “Always” (iOS) or “Allow all the time” (Android) so your position is shared while the app is in the background.'
				: 'Your position is shared while this page stays open. Install the app to share it in the background.' },
		notifications: { icon: 'lucide:bell', label: 'Notifications', why: 'New assignments and changes reach you even when the app is closed.' },
		camera: { icon: 'lucide:camera', label: 'Camera', why: 'This app takes photos or recognises faces with the camera.' }
	});

	let states = $state<Partial<Record<DeviceRequirement, DeviceState>>>({});
	let busy = $state<DeviceRequirement | null>(null);
	const refresh = async () => {
		const next: Partial<Record<DeviceRequirement, DeviceState>> = {};
		for (const r of requires) next[r] = await device.check(r).catch(() => ({ state: 'prompt' as const, settings: false }));
		states = next;
	};
	const missing = $derived(requires.filter((r) => states[r]?.state !== 'granted'));
	const checked = $derived(requires.every((r) => states[r] !== undefined));

	$effect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 3000);
		const back = () => { if (document.visibilityState === 'visible') void refresh(); };
		document.addEventListener('visibilitychange', back);
		return () => { clearInterval(timer); document.removeEventListener('visibilitychange', back); };
	});

	async function allow(r: DeviceRequirement) {
		busy = r;
		try {
			const s = states[r];
			if (s?.state === 'denied' && s.settings) await device.openSettings(r);
			else await device.request(r);
		} finally {
			busy = null;
			await refresh();
		}
	}
</script>

{#if checked && missing.length === 0}
	{@render children()}
{:else if checked}
	<Center class="min-h-full p-6" data-device-wall>
		<Stack gap="lg" class="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
			<Stack gap="xs">
				<h2 class="text-xl font-semibold">{t('Allow access to continue')}</h2>
				<p class="text-sm text-muted-foreground">{t('This app needs the following on this device. It opens as soon as each is allowed.')}</p>
			</Stack>
			<Stack as="ul" gap="md">
				{#each requires as r (r)}
					{@const s = states[r]}
					<li data-requirement={r} data-state={s?.state}>
						<Inline gap="sm" align="start">
							<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-muted"><Icon name={COPY[r].icon} class="size-4" /></span>
							<Stack gap="xs" grow>
								<Inline gap="xs" justify="between">
									<p class="text-sm font-medium">{t(COPY[r].label)}</p>
									{#if s?.state === 'granted'}<Badge variant="success">{t('Allowed')}</Badge>
									{:else if s?.state === 'unsupported'}<Badge variant="outline">{t('Not available here')}</Badge>
									{:else}<Badge variant="warning">{t('Needed')}</Badge>{/if}
								</Inline>
								<p class="text-xs text-muted-foreground">{t(COPY[r].why)}</p>
								{#if s?.state === 'prompt' || (s?.state === 'denied' && s.settings)}
									<Button size="sm" class="self-start" disabled={busy !== null} onclick={() => allow(r)}>
										{t(s.state === 'denied' ? 'Open settings' : 'Allow')}
									</Button>
								{:else if s?.state === 'denied'}
									<p class="text-xs">{t('Blocked in this browser. Allow it in the site settings (the icon beside the address), then return here.')}</p>
								{:else if s?.state === 'unsupported'}
									<p class="text-xs">{t('This browser cannot provide it. Open this app on a phone or in another browser.')}</p>
								{/if}
							</Stack>
						</Inline>
					</li>
				{/each}
			</Stack>
		</Stack>
	</Center>
{/if}
