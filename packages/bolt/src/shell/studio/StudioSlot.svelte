<!--
	Studio's place in the shell: an empty element the host's bundle mounts into (`slot.ts`). Unmounts on leave, and says so
	plainly when the bundle cannot be loaded.
-->
<script lang="ts">
	import { EmptyState } from '@norbital-ai/ui';
	import { attach } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { untrack } from 'svelte';
	import { based } from '../nav.ts';
	import { isMountStudio, type StudioMount, type StudioProps } from './slot.ts';

	let {
		bundle,
		props
	}: {
		/** Where the host serves it; absent: this host serves none. */
		bundle: string | undefined;
		props: StudioProps;
	} = $props();
	let failed = $state(false);
	let mounted: StudioMount | undefined;
	const open = (path: string, target: HTMLElement) =>
		Effect.gen(function* () {
			const module = yield* Effect.tryPromise(
				(): Promise<{ readonly mountStudio?: unknown }> => import(/* @vite-ignore */ based(path))
			);
			if (!isMountStudio(module.mountStudio))
				return yield* Effect.fail(new Error('The Studio bundle exports no mountStudio.'));
			return (mounted = module.mountStudio(target, props));
		});
	const slot = attach((target: HTMLDivElement) => {
		// read once: a later boot naming a newer bundle must not remount Studio over unsaved edits
		const path = untrack(() => bundle);
		return path === undefined
			? Effect.void
			: Effect.acquireRelease(open(path, target), (view) =>
					Effect.promise(() => view.unmount()).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								mounted = undefined;
							})
						)
					)
				).pipe(
					Effect.andThen(Effect.never),
					Effect.catch((cause) =>
						Effect.logWarning(cause).pipe(
							Effect.andThen(
								Effect.sync(() => {
									failed = true;
								})
							)
						)
					)
				);
	});
	watch(
		() => props,
		(next) => mounted?.update(next)
	);
</script>

{#if bundle === undefined || failed}
	<EmptyState
		size="fill"
		tone="danger"
		title={props.t('Workspace Studio could not be loaded.')}
		hint={props.t('Reload the page. If it keeps happening, the host is not serving Studio.')}
	/>
{:else}
	<div class="flex min-h-0 min-w-0 flex-1 flex-col" {@attach slot}></div>
{/if}
