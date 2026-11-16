<script lang="ts">
	import { PhoneVerify } from '@norbital-ai/ui';
	import type { CodeSession } from '../../../ui/src/pin-input/index.js';
	let { session }: { session: CodeSession } = $props();
</script>

<PhoneVerify ctx={{ ui: { kinds: { locale: 'en-SG' } } }} {session} />
