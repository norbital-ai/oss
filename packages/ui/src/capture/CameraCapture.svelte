<!--
@component
Takes a photo with the device camera (front or back) and hands it to `onCapture` as a `File`.
-->
<script lang="ts" module>
	/** The props of `CameraCapture`. */
	export type CameraCaptureProps = {
		facing?: 'user' | 'environment';
		onCapture: (file: File) => void;
		label?: string;
	};
</script>

<script lang="ts">
	import { Clock, Effect } from 'effect';
	import { attach, fork } from '../effect/index.js';
	// A photo from the device camera; without a camera (or permission) the native file picker's capture takes over.
	import { Button } from '../primitives/button/index.js';
	import { useBolt } from '../client/context.js';
	import { msg } from '../text/messages.js';

	let { facing = 'environment', onCapture, label }: CameraCaptureProps = $props();
	const bolt = useBolt();
	let video = $state<HTMLVideoElement>();
	let failed = $state(false);

	const camera = attach((node: HTMLVideoElement) =>
		Effect.gen(function* () {
			const devices = navigator.mediaDevices;
			if (devices === undefined) {
				failed = true;
				return;
			}
			const stream = yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: () => devices.getUserMedia({ video: { facingMode: facing }, audio: false }),
					catch: (cause) => ({ _tag: 'CameraFailed' as const, cause })
				}),
				(stream) =>
					Effect.sync(() => {
						stream.getTracks().forEach((track) => track.stop());
						node.srcObject = null;
					})
			);
			node.srcObject = stream;
			yield* Effect.tryPromise({
				try: () => node.play(),
				catch: (cause) => ({ _tag: 'CameraFailed' as const, cause })
			});
			yield* Effect.never;
		}).pipe(
			Effect.catch(() =>
				Effect.sync(() => {
					failed = true;
				})
			)
		)
	);

	function snap() {
		if (video === undefined || video.videoWidth === 0) return;
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext('2d')?.drawImage(video, 0, 0);
		fork(
			Clock.currentTimeMillis.pipe(
				Effect.tap((millis) =>
					Effect.sync(() => {
						canvas.toBlob(
							(blob) => {
								if (blob !== null)
									onCapture(
										new File(
											[blob],
											`photo-${new Date(millis).toISOString().replace(/[:.]/g, '-')}.jpg`,
											{ type: 'image/jpeg' }
										)
									);
							},
							'image/jpeg',
							0.9
						);
					})
				)
			)
		);
	}
</script>

<div class="flex flex-col gap-2" data-view="camera">
	{#if failed}
		<label class="text-sm">
			<span class="text-muted-foreground"
				>{msg(bolt, 'camera.unavailable', 'No camera here; choose or take a photo')}</span
			>
			<input
				type="file"
				accept="image/*"
				capture={facing}
				onchange={(e) => {
					const f = e.currentTarget.files?.[0];
					if (f) onCapture(f);
				}}
			/>
		</label>
	{:else}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={video}
			{@attach camera}
			playsinline
			muted
			class={['w-full rounded-md bg-black', facing === 'user' && '-scale-x-100']}
		></video>
		<Button onclick={snap}>{label ?? msg(bolt, 'camera.capture', 'Take photo')}</Button>
	{/if}
</div>
