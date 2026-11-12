<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { SnakeProps } from '../bits.js';
	let { ref = $bindable(null), force_mount, ...rest }: SnakeProps<Dialog.OverlayProps, { force_mount: 'forceMount' }> = $props();
</script>

<Dialog.Overlay bind:ref {...rest} forceMount={force_mount} />
