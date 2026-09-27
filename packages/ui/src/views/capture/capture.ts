// CaptureKit's machines (M5), ported from hr-payroll's kiosk (`lib/kiosk/guided-capture.ts`, `voice.ts`) and made generic:
// the guided pose hold and the one-at-a-time voice queue. Pure: the component feeds frames and plays clips.

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
const YAW_LEFT = -1, PITCH_UP = -1;
const STRAIGHT = deg(9), TURN: [number, number] = [deg(14), deg(45)], TILT: [number, number] = [deg(11), deg(40)], CROSS = deg(16);
const signed = (sign: number, [min, max]: [number, number]): [number, number] => sign > 0 ? [min, max] : [-max, -min];
const WINDOWS: { readonly [P in Pose]: { yaw: [number, number]; pitch: [number, number] } } = {
	straight: { yaw: [-STRAIGHT, STRAIGHT], pitch: [-STRAIGHT, STRAIGHT] },
	left: { yaw: signed(YAW_LEFT, TURN), pitch: [-CROSS, CROSS] },
	right: { yaw: signed(-YAW_LEFT, TURN), pitch: [-CROSS, CROSS] },
	up: { yaw: [-CROSS, CROSS], pitch: signed(PITCH_UP, TILT) },
	down: { yaw: [-CROSS, CROSS], pitch: signed(-PITCH_UP, TILT) },
};
export const HOLD_MS = 600;
const inside = (v: number, [min, max]: [number, number]) => v >= min && v <= max;
export const inPose = (a: FaceAngle, p: Pose) => inside(a.yaw, WINDOWS[p].yaw) && inside(a.pitch, WINDOWS[p].pitch);

export type Guided = { readonly poses: readonly Pose[]; readonly captured: readonly Pose[]; readonly heldSince: number | null; readonly facePresent: boolean };
export const guided = (poses: readonly Pose[] = ['straight']): Guided => ({ poses, captured: [], heldSince: null, facePresent: false });
export const target = (s: Guided): Pose | null => s.poses[s.captured.length] ?? null;
export const progress = (s: Guided, now: number) => s.heldSince === null ? 0 : Math.min(1, (now - s.heldSince) / HOLD_MS);
/** One analysed frame: `capture` is the pose this frame completes; leaving the window or losing the descriptor restarts the hold. */
export function observe(s: Guided, o: Observation, now: number): { state: Guided; capture: Pose | null } {
	const pose = target(s);
	if (pose === null) return { state: s, capture: null };
	const facePresent = o !== null;
	if (o === null || o.angle === null || !o.embedding || !inPose(o.angle, pose)) return { state: { ...s, heldSince: null, facePresent }, capture: null };
	const heldSince = s.heldSince ?? now;
	if (now - heldSince < HOLD_MS) return { state: { ...s, heldSince, facePresent }, capture: null };
	return { state: { ...s, captured: [...s.captured, pose], heldSince: null, facePresent }, capture: pose };
}

// ── the narrator: workspace clips (`voice={{ [phrase]: { [locale]: url } }}`), one at a time, never talking over itself ──
export type Clip = { done: Promise<'played' | 'missing' | 'stopped'>; stop(): void };
/** Spoken prompt clips: per phrase, per locale, a path under the workspace's `assets/`. */
export type Voice = { readonly [phrase: string]: { readonly [locale: string]: string } };
/** A phrase arriving while this many wait evicts the oldest waiting one. */
const MAX_PENDING = 2;
export function narrator(play: (url: string) => Clip, voice: Voice, options: { locale: string; enabled?: boolean }) {
	let locale = options.locale, enabled = options.enabled ?? true, generation = 0;
	const missing = new Set<string>(), pending: string[] = [];
	let current: { phrase: string; clip: Clip } | null = null;
	async function drain(mine: number) {
		while (mine === generation) {
			const phrase = pending.shift();
			if (phrase === undefined) { current = null; return; }
			// a phrase without a clip is silent: `bolt check` refuses a declared phrase with no clip (assets/missing)
			const url = voice[phrase]?.[locale];
			if (url === undefined || missing.has(url)) continue;
			const clip = play(url);
			current = { phrase, clip };
			if (await clip.done === 'missing') missing.add(url);
		}
	}
	const stop = () => { generation += 1; pending.length = 0; current?.clip.stop(); current = null; };
	return {
		say(phrase: string) {
			if (!enabled || (pending.at(-1) ?? current?.phrase) === phrase) return;
			if (pending.length >= MAX_PENDING) pending.shift();
			pending.push(phrase);
			if (current === null) void drain(generation);
		},
		stop,
		setLocale(next: string) { locale = next; },
		setEnabled(next: boolean) { enabled = next; if (!next) stop(); },
		missing,
	};
}
/** The browser player; an autoplay refusal is `stopped`, not `missing`, so the clip is tried again after a touch. */
export const audioClip = (url: string): Clip => {
	const audio = new Audio(url);
	let settle: (o: 'played' | 'missing' | 'stopped') => void = () => {};
	const done = new Promise<'played' | 'missing' | 'stopped'>((resolve) => (settle = resolve));
	audio.addEventListener('ended', () => settle('played'), { once: true });
	audio.addEventListener('error', () => settle('missing'), { once: true });
	audio.play().catch((e: unknown) => settle(e instanceof DOMException && e.name === 'NotAllowedError' ? 'stopped' : 'missing'));
	return { done, stop: () => { audio.pause(); settle('stopped'); } };
};
