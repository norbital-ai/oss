<!--
	@component
	Studio's place in a page: an element the host's Studio `bundle` mounts into with `props`. The bundle path is read
	once; new `props` update the mounted Studio without a remount. It unmounts on leave and shows an empty state when the
	bundle cannot be loaded.
-->
<script lang="ts">
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import { attach } from '../effect/index.js';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { untrack } from 'svelte';
	import { mount_studio, type StudioMount, type StudioProps } from './slot.js';

	let {
		bundle,
		props
	}: {
		/** The bundle's browser URL; absent: this host serves none. */
		bundle: string | undefined;
		/** What the shell hands Studio; a change updates the mounted Studio in place. */
		props: StudioProps;
	} = $props();
	let failed = $state(false);
	let mounted: StudioMount | undefined;
	const open = (path: string, target: HTMLElement) =>
		Effect.gen(function* () {
			const module = yield* Effect.tryPromise(
				(): Promise<unknown> => import(/* @vite-ignore */ path)
			);
			return (mounted = yield* Effect.try(() => mount_studio(module, target, props)));
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
