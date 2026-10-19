// CaptureKit's machines (M5), ported from hr-payroll's kiosk (`lib/kiosk/guided-capture.ts`, `voice.ts`) and made generic:
// the guided pose hold (pure: the component feeds it frames) and the one-at-a-time voice queue (an Effect the component
// runs on the ui edge).
import { Deferred, Effect, Queue, Schema, type Scope } from 'effect';

// ── guided capture: the flow asks for a pose and takes the frame once it is held, with a descriptor, for 600 ms ──
/** The head poses a guided capture can ask for. */
export const POSES = ['straight', 'left', 'right', 'up', 'down'] as const;
/** One head pose. */
export type Pose = (typeof POSES)[number];
/** Radians, as the face engine reports them. */
export type FaceAngle = { readonly yaw: number; readonly pitch: number };
export type Observation = { readonly angle: FaceAngle | null; readonly embedding: boolean } | null;

const deg = (v: number) => (v * Math.PI) / 180;
// The person's own left: a turn to their left reads negative yaw, looking up negative pitch (settled on a live camera
// 2026-09-08 in the kiosk); every instruction is in the person's frame, never the camera's.
const YAW_LEFT = -1,
	PITCH_UP = -1;
const STRAIGHT = deg(9),
	TURN: [number, number] = [deg(14), deg(45)],
	TILT: [number, number] = [deg(11), deg(40)],
	CROSS = deg(16);
const signed = (sign: number, [min, max]: [number, number]): [number, number] =>
	sign > 0 ? [min, max] : [-max, -min];
const WINDOWS: { readonly [P in Pose]: { yaw: [number, number]; pitch: [number, number] } } = {
	straight: { yaw: [-STRAIGHT, STRAIGHT], pitch: [-STRAIGHT, STRAIGHT] },
	left: { yaw: signed(YAW_LEFT, TURN), pitch: [-CROSS, CROSS] },
	right: { yaw: signed(-YAW_LEFT, TURN), pitch: [-CROSS, CROSS] },
	up: { yaw: [-CROSS, CROSS], pitch: signed(PITCH_UP, TILT) },
	down: { yaw: [-CROSS, CROSS], pitch: signed(-PITCH_UP, TILT) }
};
export const HOLD_MS = 600;
const inside = (v: number, [min, max]: [number, number]) => v >= min && v <= max;
const inPose = (a: FaceAngle, p: Pose) =>
	inside(a.yaw, WINDOWS[p].yaw) && inside(a.pitch, WINDOWS[p].pitch);

type Guided = {
	readonly poses: readonly Pose[];
	readonly captured: readonly Pose[];
	readonly heldSince: number | null;
	readonly facePresent: boolean;
};
export const guided = (poses: readonly Pose[] = ['straight']): Guided => ({
	poses,
	captured: [],
	heldSince: null,
	facePresent: false
});
export const target = (s: Guided): Pose | null => s.poses[s.captured.length] ?? null;
export const progress = (s: Guided, now: number) =>
	s.heldSince === null ? 0 : Math.min(1, (now - s.heldSince) / HOLD_MS);
/** One analysed frame: `capture` is the pose this frame completes; leaving the window or losing the descriptor restarts the hold. */
export function observe(
	s: Guided,
	o: Observation,
	now: number
): { state: Guided; capture: Pose | null } {
	const pose = target(s);
	if (pose === null) return { state: s, capture: null };
	const facePresent = o !== null;
	if (o === null || o.angle === null || !o.embedding || !inPose(o.angle, pose))
		return { state: { ...s, heldSince: null, facePresent }, capture: null };
	const heldSince = s.heldSince ?? now;
	if (now - heldSince < HOLD_MS) return { state: { ...s, heldSince, facePresent }, capture: null };
	return {
		state: { ...s, captured: [...s.captured, pose], heldSince: null, facePresent },
		capture: pose
	};
}

// ── the narrator: workspace clips (`voice={{ [phrase]: { [locale]: url } }}`), one at a time, never talking over itself ──
type ClipStatus = 'played' | 'missing' | 'stopped';
export type Clip = { readonly done: Effect.Effect<ClipStatus>; readonly stop: Effect.Effect<void> };
/** Spoken prompt clips: per phrase, per locale, a path under the workspace's `assets/`. */
export type Voice = { readonly [phrase: string]: { readonly [locale: string]: string } };
/** A phrase arriving while this many wait evicts the oldest waiting one (the queue slides). */
const MAX_PENDING = 2;
type Narrator = {
	/** Queues a phrase, unless it is the one last said and not yet done. */
	say(phrase: string): Effect.Effect<void>;
	/** Drops the waiting phrases and stops the clip playing. */
	readonly stop: Effect.Effect<void>;
	/** Clip URLs that failed to load: never tried again. */
	readonly missing: ReadonlySet<string>;
};
/** The narrator for the scope's lifetime: one fiber takes each queued phrase and plays its clip in `locale()`. */
export const narrator = <E>(
	play: (url: string) => Effect.Effect<Clip, E, Scope.Scope>,
	voice: Voice,
	locale: () => string
): Effect.Effect<Narrator, never, Scope.Scope> =>
	Effect.gen(function* () {
		const pending = yield* Queue.sliding<string>(MAX_PENDING);
		const missing = new Set<string>();
		let last: string | null = null,
			playing: Clip | null = null;
		const speak = Effect.gen(function* () {
			const phrase = yield* Queue.take(pending);
			// a phrase without a clip is silent: `bolt check` refuses a declared phrase with no clip (assets/missing)
			const url = voice[phrase]?.[locale()];
			if (url !== undefined && !missing.has(url)) {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const clip = (playing = yield* Effect.acquireRelease(play(url), (clip) => clip.stop));
						if ((yield* clip.done) === 'missing') missing.add(url);
					})
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							playing = null;
						})
					),
					Effect.catch((error) => Effect.logWarning(error))
				);
			}
			if ((yield* Queue.size(pending)) === 0) last = null;
		});
		yield* Effect.forkScoped(
			Effect.forever(speak).pipe(Effect.onInterrupt(() => playing?.stop ?? Effect.void))
		);
		return {
			say: (phrase: string) =>
				Effect.suspend(() => {
					if (last === phrase) return Effect.void;
					last = phrase;
					return Effect.asVoid(Queue.offer(pending, phrase));
				}),
			stop: Effect.suspend(() => {
				last = null;
				return Queue.clear(pending).pipe(Effect.andThen(playing?.stop ?? Effect.void));
			}).pipe(Effect.asVoid),
			missing
		} satisfies Narrator;
	});
class AudioClipFailed extends Schema.TaggedError<AudioClipFailed>()('AudioClipFailed', {
	operation: Schema.Literals(['create', 'play']),
	cause: Schema.Defect()
}) {}
/** The scoped browser player; autoplay refusal is stopped, so a touch can retry it. */
export const audioClip = (url: string): Effect.Effect<Clip, AudioClipFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const audio = yield* Effect.try({
			try: () => new Audio(url),
			catch: (cause) => new AudioClipFailed({ operation: 'create', cause })
		});
		const done = yield* Deferred.make<ClipStatus>();
		let finished = false;
		const ended = () => complete('played');
		const failed = () => complete('missing');
		const complete = (status: ClipStatus) => {
			if (finished) return;
			finished = true;
			audio.removeEventListener('ended', ended);
			audio.removeEventListener('error', failed);
			audio.pause();
			Deferred.doneUnsafe(done, Effect.succeed(status));
		};
		const stop = Effect.sync(() => complete('stopped'));
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				audio.addEventListener('ended', ended);
				audio.addEventListener('error', failed);
			}),
			() => stop
		);
		yield* Effect.forkScoped(
			Effect.tryPromise({
				try: () => audio.play(),
				catch: (cause) => new AudioClipFailed({ operation: 'play', cause })
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() =>
						complete(
							error.cause instanceof DOMException && error.cause.name === 'NotAllowedError'
								? 'stopped'
								: 'missing'
						)
					)
				)
			)
		);
		return { done: Deferred.await(done), stop };
	});
