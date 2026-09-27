<!--
@component
A guided face capture: prompts through `poses`, holds each until the face engine sees it, optionally checks liveness and speaks the prompts, and reports each capture.
-->
<script lang="ts" module>
	import type { FaceAngle, Pose, Voice } from './capture.js';
	/** What the page's face engine reports for one frame (models load in the page, through Vite `?url`, GAPS 30). */
	export type FaceFrame = { angle: FaceAngle | null; box?: readonly [number, number, number, number]; descriptor?: ArrayLike<number> | null };
	/** One captured pose: the photo, the face descriptor and the liveness score when measured. */
	export type Captured = { pose: Pose; file: File; descriptor: number[] | null; liveness: number | null };
	/**
	 * The props of `CaptureKit`: the poses, the page's face engine (`analyse`), liveness, voice prompts and callbacks.
	 */
	export type CaptureKitProps = {
		poses?: readonly Pose[];
		analyse: (frame: HTMLCanvasElement) => Promise<FaceFrame | null>;
		/** Anti-spoof score in 0–1 over the face box; a frame under `livenessMin` is refused and the pose held again. */
		liveness?: (frame: HTMLCanvasElement, box: readonly [number, number, number, number]) => Promise<number>;
		livenessMin?: number;
		/** Phrases: each pose's name, `done`, `spoof`, `noFace`; clips under the workspace's `assets/`. */
		voice?: Voice;
		locale?: string;
		onCapture: (c: Captured) => void;
		onDone?: () => void;
	};
</script>

<script lang="ts">
	// Guided face capture with liveness and voice prompts (M5, `@norbital-ai/ui/capture`): no capture button; each pose is
	// taken once it is held with a readable descriptor, as the hr kiosk and enrolment flows do today.
	import { untrack } from 'svelte';
	import { audioClip, guided, narrator, observe, progress, target } from './capture.js';

	let { poses = ['straight'], analyse, liveness, livenessMin = 0.5, voice = {}, locale = 'en', onCapture, onDone }: CaptureKitProps = $props();
	let flow = $state(untrack(() => guided(poses)));
	let hold = $state(0);
	let failed = $state(false);
	const voiceOf = untrack(() => narrator(audioClip, voice, { locale }));
	$effect(() => voiceOf.setLocale(locale));
	$effect(() => { const p = target(flow); voiceOf.say(p ?? 'done'); });

	function camera(video: HTMLVideoElement) {
		let stream: MediaStream | undefined, stopped = false, busy = false;
		const canvas = document.createElement('canvas');
		const tick = async () => {
			if (stopped) return;
			if (!busy && video.videoWidth > 0 && target(flow) !== null) {
				busy = true;
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				canvas.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0);
				const f = await analyse(canvas).catch(() => null);
				const now = performance.now();
				const step = observe(flow, f === null ? null : { angle: f.angle, embedding: f.descriptor != null }, now);
				if (step.capture !== null && f !== null) {
					const score = liveness && f.box ? await liveness(canvas, f.box) : null;
					if (score !== null && score < livenessMin) {
						voiceOf.say('spoof');
						flow = { ...flow, heldSince: null };
					} else {
						flow = step.state;
						const pose = step.capture;
						canvas.toBlob((b) => b && onCapture({ pose, file: new File([b], `${pose}.jpg`, { type: 'image/jpeg' }), descriptor: f.descriptor ? Array.from(f.descriptor) : null, liveness: score }), 'image/jpeg', 0.9);
						if (target(flow) === null) onDone?.();
					}
				} else {
					if (!step.state.facePresent && flow.facePresent) voiceOf.say('noFace');
					flow = step.state;
				}
				hold = progress(flow, now);
				busy = false;
			}
			setTimeout(tick, 120);
		};
		navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user' }, audio: false }).then((s) => {
			stream = s;
			video.srcObject = s;
			void video.play();
			void tick();
		}, () => (failed = true));
		return { destroy() { stopped = true; voiceOf.stop(); stream?.getTracks().forEach((t) => t.stop()); } };
	}
</script>

<div class="flex flex-col items-center gap-2" data-view="capture-kit" data-pose={target(flow) ?? 'done'}>
	{#if failed}
		<p role="alert" class="text-destructive text-sm">Camera unavailable</p>
	{:else}
		<!-- the preview is mirrored by CSS only; analysis reads the unmirrored frame -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video use:camera playsinline muted class="aspect-[3/4] w-full max-w-sm -scale-x-100 rounded-md bg-black object-cover"></video>
		<progress class="h-1 w-full max-w-sm" max="1" value={hold}></progress>
		<p class="text-sm" aria-live="polite">{target(flow) ?? 'done'}</p>
	{/if}
</div>
