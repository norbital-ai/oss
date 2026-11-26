<!-- @component Built-in Bolt Shell route `/connections`: personal accounts synced for the signed-in member. -->
<script lang="ts">
	import type { ShellPageContext } from '../runtime.ts';
	import Connections from '../../page/Connections.svelte';
	import SystemPage from '../SystemPage.svelte';
	import integrationsBanner from '../assets/banners/integrations.jpg';

	let {
		ctx,
		t
	}: {
		ctx: ShellPageContext;
		t: (key: string) => string;
	} = $props();
</script>

<SystemPage
	name="connections"
	title={t('My connections')}
	icon="concept:integrations"
	banner={integrationsBanner}
	description={t('Personal accounts synced for you. They never send messages on your behalf.')}
>
	<Connections {ctx} scope="personal" translate={t} />
</SystemPage>
