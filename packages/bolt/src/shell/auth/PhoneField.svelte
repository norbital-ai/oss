<!--
	The sign-in card's mobile number: the kit's phone input under the workspace's locale, so a number typed without its
	country code reads as the workspace's region (a Singapore workspace's `8123 4567` is `+6581234567`).
-->
<script lang="ts">
	import { PhoneInput, provide_kinds } from '@norbital-ai/ui';

	let {
		locale,
		value,
		on_change,
		id
	}: { locale: string; value: string | null; on_change: (next: string | null) => void; id: string } =
		$props();
	// svelte-ignore state_referenced_locally
	provide_kinds({ locale });
</script>

<PhoneInput {id} {value} on_change={(v) => on_change(typeof v === 'string' ? v : null)} />
