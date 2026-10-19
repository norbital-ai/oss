<!--
@component
A guided face capture: prompts through `poses`, holds each until the face engine sees it, optionally checks liveness and speaks the prompts, and reports each capture.
-->
<script lang="ts" module>
	import type { FaceAngle, Pose, Voice } from './capture.js';
	/** What the page's face engine reports for one frame (models load in the page, through Vite `?url`, GAPS 30). */
	export type FaceFrame = {
		angle: FaceAngle | null;
		box?: readonly [number, number, number, number];
		descriptor?: ArrayLike<number> | null;
	};
	/** One captured pose: the photo, the face descriptor and the liveness score when measured. */
	export type Captured = {
		pose: Pose;
		file: File;
		descriptor: number[] | null;
		liveness: number | null;
	};
	/**
	 * The props of `CaptureKit`: the poses, the page's face engine (`analyse`), liveness, voice prompts and callbacks.
	 */
	export type CaptureKitProps = {
		poses?: readonly Pose[];
		analyse: (frame: HTMLCanvasElement) => Promise<FaceFrame | null>;
		/** Anti-spoof score in 0–1 over the face box; a frame under `livenessMin` is refused and the pose held again. */
		liveness?: (
			frame: HTMLCanvasElement,
			box: readonly [number, number, number, number]
		) => Promise<number>;
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
	import { Clock, Effect, Schedule, Schema } from 'effect';
	import { untrack } from 'svelte';
	import { attach } from '../effect/index.js';
	import { audioClip, guided, narrator, observe, progress, target } from './capture.js';
	class LivenessFailed extends Schema.TaggedError<LivenessFailed>()('LivenessFailed', {
		cause: Schema.Defect()
	}) {}

	let {
		poses = ['straight'],
		analyse,
		liveness,
		livenessMin = 0.5,
		voice = {},
		locale = 'en',
		onCapture,
		onDone
	}: CaptureKitProps = $props();
	let flow = $state(untrack(() => guided(poses)));
	let hold = $state(0);
	let failed = $state(false);

	/** The prompts, the camera and the analysis loop (every 120 ms), for the video element's lifetime (D13: device I/O). */
	const camera = (video: HTMLVideoElement) =>
		Effect.gen(function* () {
			const prompts = yield* narrator(audioClip, voice, () => locale);
			const prompt = () => prompts.say(target(flow) ?? 'done');
			yield* prompt();
			const devices = navigator.mediaDevices;
			if (devices === undefined) return;
			const stream = yield* Effect.acquireRelease(
				Effect.tryPromise(() =>
					devices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
				),
				(s) => Effect.sync(() => s.getTracks().forEach((t) => t.stop()))
			);
			video.srcObject = stream;
			yield* Effect.tryPromise(() => video.play()).pipe(
				Effect.tapCause(Effect.logWarning),
				Effect.ignore
			);
			const canvas = document.createElement('canvas');
			const frame = Effect.gen(function* () {
				if (video.videoWidth === 0 || target(flow) === null) return;
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				canvas.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0);
				// a frame the engine cannot read shows no face
				const f = yield* Effect.tryPromise(() => analyse(canvas)).pipe(
					Effect.orElseSucceed(() => null)
				);
				const now = yield* Clock.currentTimeMillis;
				const step = observe(
					flow,
					f === null ? null : { angle: f.angle, embedding: f.descriptor != null },
					now
				);
				if (step.capture !== null && f !== null) {
					const box = f.box,
						live = liveness;
					const score =
						live && box
							? yield* Effect.tryPromise({
									try: () => live(canvas, box),
									catch: (cause) => new LivenessFailed({ cause })
								})
							: null;
					if (score !== null && score < livenessMin) {
						yield* prompts.say('spoof');
						flow = { ...flow, heldSince: null };
					} else {
						flow = step.state;
						const pose = step.capture;
						canvas.toBlob(
							(b) =>
								b &&
								onCapture({
									pose,
									file: new File([b], `${pose}.jpg`, { type: 'image/jpeg' }),
									descriptor: f.descriptor ? Array.from(f.descriptor) : null,
									liveness: score
								}),
							'image/jpeg',
							0.9
						);
						if (target(flow) === null) onDone?.();
					}
				} else {
					if (!step.state.facePresent && flow.facePresent) yield* prompts.say('noFace');
					flow = step.state;
				}
				hold = progress(flow, now);
				yield* prompt();
			});
			yield* frame.pipe(Effect.repeat(Schedule.spaced('120 millis')));
		}).pipe(
			Effect.catch(() =>
				Effect.sync(() => {
					failed = true;
				})
			)
		);
</script>

<div
	class="flex flex-col items-center gap-2"
	data-view="capture-kit"
	data-pose={target(flow) ?? 'done'}
>
	{#if failed}
		<p role="alert" class="text-destructive text-sm">Camera unavailable</p>
	{:else}
		<!-- the preview is mirrored by CSS only; analysis reads the unmirrored frame -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			{@attach attach(camera)}
			playsinline
			muted
			class="aspect-[3/4] w-full max-w-sm -scale-x-100 rounded-md bg-black object-cover"
		></video>
		<progress class="h-1 w-full max-w-sm" max="1" value={hold}></progress>
		<p class="text-sm" aria-live="polite">{target(flow) ?? 'done'}</p>
	{/if}
</div>
