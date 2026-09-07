<script lang="ts">
	import { Effect } from 'effect';
	import {
		DataRenderer,
		setDataRendererRuntimeContext,
		type CustomTypeRenderer
	} from '@norbital-ai/ui/data-renderer';
	import { createCustomTypeRendererResolver } from '../../src/client/ui/shell/custom-type-renderers.svelte.js';

	let { load, value }: { load: () => Promise<CustomTypeRenderer>; value: unknown } = $props();
	const unavailable = () => Effect.fail(new Error('unused in this test'));
	setDataRendererRuntimeContext({
		customTypeRenderer: createCustomTypeRendererResolver({ pay_calendar: () => load() }),
		fileUrl: (key) => key,
		autocompleteGeolocation: unavailable,
		renderStaticMap: unavailable,
		createFileUploadClient: () => {
			throw new Error('unused in this test');
		}
	});
</script>

<DataRenderer field={{ name: 'pay_calendar', kind: 'pay_calendar', nullable: true }} {value} />
