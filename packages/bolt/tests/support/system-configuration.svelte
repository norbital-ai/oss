<script lang="ts">
	import { provide_bolt, provide_kinds } from '@norbital-ai/ui';
	import type { ShellApi } from '../../src/shell/api-types.ts';
	import type { ShellBolt } from '../../src/shell/runtime.ts';
	import type { SettingsTab, ShellBoot } from '../../src/shell/nav.ts';
	import type { SystemUiIntent } from '../../src/protocol/system-ui.ts';
	import type { IntegrationSetupEntry } from '../../src/page/integration.ts';
	import { view_client } from '../../src/page/view-client.ts';
	import Settings from '../../src/shell/settings/Settings.svelte';
	import People from '../../src/shell/people/People.svelte';
	let {
		api,
		bolt,
		t,
		tab,
		workspace,
		configuration,
		people = false,
		integration_setups
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tab: SettingsTab;
		workspace: ShellBoot['workspace'];
		configuration: SystemUiIntent;
		people?: boolean;
		integration_setups?: { readonly [integration: string]: IntegrationSetupEntry };
	} = $props();
	// The mounted fixture owns one native shell client for its whole lifetime; its controls read through the shell's view client.
	// svelte-ignore state_referenced_locally
	const view = view_client(bolt, {}, {});
	provide_bolt(() => view);
	provide_kinds({
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
	<Settings {api} {bolt} {t} {tab} {workspace} {configuration} {integration_setups} />
{/if}
