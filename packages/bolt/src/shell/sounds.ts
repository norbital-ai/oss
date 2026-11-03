export const SOUNDS = Symbol('sounds');
export type SoundKind = 'approval' | 'complete' | 'notification';
export type SoundStatus = 'needs-gesture' | 'ready' | 'blocked' | 'unavailable';
export type Sounds = { play(kind: SoundKind): void };

/** Initial inbox contents and read-state changes are silent, including older rows entering the page. */
export function noticeArrivals() {
	let previous: Set<string> | undefined;
	let latest = '';
	return (rows: readonly { id: string; read: boolean; at: string }[]): boolean => {
		const before = previous;
		const arrived =
			before !== undefined &&
			rows.some((row) => !row.read && !before.has(row.id) && row.at >= latest);
		previous = new Set(rows.map((row) => row.id));
		for (const row of rows) if (row.at > latest) latest = row.at;
		return arrived;
	};
}

/** One device-local audio context for every shell sound; blocked events are never queued. */
export function createSounds(enabled: () => boolean, changed: (status: SoundStatus) => void) {
	let audio: AudioContext | undefined;
	let closed = false;
	const last = new Map<SoundKind, number>();
	const status = (value: SoundStatus) => {
		if (!closed) changed(value);
	};
	const unlock = async (): Promise<boolean> => {
		if (closed || !enabled()) return false;
		if (typeof AudioContext === 'undefined') {
			status('unavailable');
			return false;
		}
		try {
			if (audio === undefined || audio.state === 'closed') {
				audio = new AudioContext();
				audio.onstatechange = () => status(audio?.state === 'running' ? 'ready' : 'blocked');
			}
			// A resume promise can remain pending when Chrome blocks sound. Show recovery immediately.
			status(audio.state === 'running' ? 'ready' : 'blocked');
			await audio.resume();
			status(audio.state === 'running' ? 'ready' : 'blocked');
			return !closed && audio.state === 'running';
		} catch {
			status('blocked');
			return false;
		}
	};
	const play = (kind: SoundKind, test = false) => {
		if (closed || !enabled() || audio?.state !== 'running') return;
		const now = performance.now();
		if (!test && now - (last.get(kind) ?? -Infinity) < 10_000) return;
		if (!test) last.set(kind, now);
		const notes =
			kind === 'approval'
				? [440, 554.37]
				: kind === 'notification'
					? [659.25, 880]
					: [554.37, 659.25];
		for (const [index, frequency] of notes.entries()) {
			const at = audio.currentTime + index * 0.13;
			const oscillator = audio.createOscillator(),
				gain = audio.createGain();
			oscillator.type = 'sine';
			oscillator.frequency.value = frequency;
			gain.gain.setValueAtTime(0, at);
			gain.gain.linearRampToValueAtTime(0.06, at + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
			oscillator.connect(gain);
			gain.connect(audio.destination);
			oscillator.start(at);
			oscillator.stop(at + 0.3);
			oscillator.onended = () => {
				oscillator.disconnect();
				gain.disconnect();
			};
		}
	};
	return {
		unlock,
		play,
		async test() {
			if (await unlock()) play('notification', true);
		},
		close() {
			closed = true;
			if (audio !== undefined) {
				audio.onstatechange = null;
				void audio.close().catch(() => {});
			}
		}
	};
}
