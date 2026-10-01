<script lang="ts">
	// Mounts the built-in `file` field under a host that uploads, serves file URLs and reads `sys_file` / `sys_user`.
	import FileField from '../src/kinds/builtin/file.svelte';
	import { provideKinds, type CustomFieldView, type KindsHost } from '../src/kinds/context.js';

	let { host, view }: { host: KindsHost; view: CustomFieldView } = $props();
	// svelte-ignore state_referenced_locally
	provideKinds(host);
</script>

<FileField {view} />
