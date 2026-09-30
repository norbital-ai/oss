<!--
	The sign-in card's mobile number: the kit's phone input under the workspace's locale, so a number typed without its
	country code reads as the workspace's region (a Singapore workspace's `8123 4567` is `+6581234567`).
-->
<script lang="ts">
	import { PhoneInput, provideKinds } from '@norbital-ai/ui';

	let { locale, value, onChange, id }: { locale: string; value: string | null; onChange: (next: string | null) => void; id: string } = $props();
	// svelte-ignore state_referenced_locally
	provideKinds({ locale });
</script>

<PhoneInput {id} {value} onChange={(v) => onChange(typeof v === 'string' ? v : null)} />
