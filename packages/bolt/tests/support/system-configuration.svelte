<script lang="ts">
	import { provideBolt, provideKinds } from '@norbital-ai/ui';
	import type { ShellApi } from '../../src/shell/api-types.ts';
	import type { ShellBolt } from '../../src/shell/runtime.ts';
	import type { SettingsTab, ShellBoot } from '../../src/shell/nav.ts';
	import type { SystemUiIntent } from '../../src/protocol/system-ui.ts';
	import Settings from '../../src/shell/settings/Settings.svelte';
	import People from '../../src/shell/people/People.svelte';
	let {
		api,
		bolt,
		t,
		tab,
		workspace,
		configuration,
		people = false
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tab: SettingsTab;
		workspace: ShellBoot['workspace'];
		configuration: SystemUiIntent;
		people?: boolean;
	} = $props();
	// The mounted fixture owns one native shell client for its whole lifetime.
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get locale() {
			return workspace.locale;
		},
		get zone() {
			return workspace.tz;
		}
	});
</script>

{#if people}
	<People {api} {t} locale={workspace.locale} {configuration} />
{:else}
	<Settings {api} {bolt} {t} {tab} {workspace} {configuration} />
{/if}
