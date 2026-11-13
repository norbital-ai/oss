<!--
	The print route (`?record=<model>/<id>&print`) the host's browser renders for `ctx.convert.record`: the record's own
	view (`RecordShell`: its `+representation.svelte`, else the generated view) alone, without app chrome or the footer's
	controls, laid out for paper. Once the view is shown and nothing in it is busy (`aria-busy`) for two frames and the
	fonts have loaded, `<html data-bolt-print="ready">` tells the host to print.
-->
<script lang="ts">
	import { RecordShell, type UiContext } from '@norbital-ai/ui';

	let { ctx, model, id }: { ctx: UiContext; model: string; id: string } = $props();

	const settle = (root: HTMLElement) => {
		let frame = 0;
		const check = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				frame = requestAnimationFrame(() => {
					if (root.querySelector('[data-view=record]') === null) return;
					if (root.querySelector('[aria-busy="true"]') !== null) return;
					void document.fonts.ready.then(() => {
						document.documentElement.dataset['boltPrint'] = 'ready';
					});
				});
			});
		};
		const observer = new MutationObserver(check);
		observer.observe(root, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['aria-busy']
		});
		check();
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			delete document.documentElement.dataset['boltPrint'];
		};
	};
</script>

<div class="bolt-print" data-bolt-print-root {@attach settle}>
	<RecordShell {ctx} of={model} {id} />
</div>

<style>
	/* paper has no scroll port: every bounded region grows to its content, and the footer's controls stay on screen */
	.bolt-print :global([data-view='record']),
	.bolt-print :global([data-record-main]) {
		height: auto !important;
		max-height: none !important;
		overflow: visible !important;
	}
	.bolt-print :global([data-record-foot]) {
		display: none;
	}
	@media print {
		.bolt-print :global(*) {
			overflow: visible !important;
			max-height: none !important;
		}
	}
</style>
