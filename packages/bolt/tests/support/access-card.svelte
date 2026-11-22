<script lang="ts">
	import Access from '../../src/shell/auth/Access.svelte';
	import SignIn from '../../src/shell/auth/SignIn.svelte';
	import Invite from '../../src/shell/auth/Invite.svelte';
	import type { ShellApi } from '../../src/shell/api-types.ts';

	let {
		api,
		invitation,
		recovery,
		next = '/'
	}: {
		api: ShellApi;
		invitation?: { id: string; signedIn: boolean };
		recovery?: string;
		next?: string;
	} = $props();
	const t = (key: string) => key;
</script>

<Access {t} locale="en" on_locale={() => {}} dark={false} on_theme={() => {}} apex="/" {recovery}>
	{#if invitation}
		<Invite {api} {t} id={invitation.id} signed_in={invitation.signedIn} workspace="Acme" />
	{:else}
		<SignIn {api} {t} {next} workspace="Acme" />
	{/if}
</Access>
