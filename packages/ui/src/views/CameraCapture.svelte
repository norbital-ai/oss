<!--
@component
Takes a photo with the device camera (front or back) and hands it to `onCapture` as a `File`.
-->
<script lang="ts" module>
	/** The props of `CameraCapture`. */
	export type CameraCaptureProps = { facing?: 'user' | 'environment'; onCapture: (file: File) => void; label?: string };
</script>

<script lang="ts">
	// A photo from the device camera; without a camera (or permission) the native file picker's capture takes over.
	import { Button } from '../primitives/button/index.js';
	import { useBolt } from './bolt.js';
	import { msg } from './model.js';

	let { facing = 'environment', onCapture, label }: CameraCaptureProps = $props();
	const bolt = useBolt();
	let video = $state<HTMLVideoElement>();
	let failed = $state(false);

	function camera(node: HTMLVideoElement) {
		let stream: MediaStream | undefined, cancelled = false;
		navigator.mediaDevices?.getUserMedia({ video: { facingMode: facing }, audio: false }).then((s) => {
			if (cancelled) return s.getTracks().forEach((t) => t.stop());
			stream = s;
			node.srcObject = s;
			void node.play();
		}, () => (failed = true)) ?? (failed = true);
		return { destroy() { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); } };
	}
	function snap() {
		if (video === undefined || video.videoWidth === 0) return;
		const canvas = document.createElement('canvas');
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvas.getContext('2d')?.drawImage(video, 0, 0);
		canvas.toBlob((b) => b && onCapture(new File([b], `photo-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.9);
	}
</script>

<div class="flex flex-col gap-2" data-view="camera">
	{#if failed}
		<label class="text-sm">
			<span class="text-muted-foreground">{msg(bolt, 'camera.unavailable', 'No camera here; choose or take a photo')}</span>
			<input type="file" accept="image/*" capture={facing} onchange={(e) => { const f = e.currentTarget.files?.[0]; if (f) onCapture(f); }} />
		</label>
	{:else}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video bind:this={video} use:camera playsinline muted class={['w-full rounded-md bg-black', facing === 'user' && '-scale-x-100']}></video>
		<Button onclick={snap}>{label ?? msg(bolt, 'camera.capture', 'Take photo')}</Button>
	{/if}
</div>
