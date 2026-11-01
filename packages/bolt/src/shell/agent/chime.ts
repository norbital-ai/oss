import type { AgentRow } from '../../protocol/schema.ts';

export const NORBIUS_CHIME = Symbol('norbius-chime');
export type ChimeKind = 'approval' | 'complete';
export type Chime = { play(kind: ChimeKind): void };

export function runTransitions() {
	let prior = new Map<string, string>();
	return (
		rows: readonly { id: string; status: string; integration: string | null }[]
	): string[] => {
		const ended = rows
			.filter(
				(row) =>
					row.integration === null && row.status === 'idle' && prior.get(row.id) === 'running'
			)
			.map((row) => row.id);
		prior = new Map(rows.map((row) => [row.id, row.status]));
		return ended;
	};
}

/** Only new events sound: opening history, switching chats and reconnecting never replay a chime. */
export function attention() {
	let previous: { conversation: string; running: boolean; pending: Set<string> } | undefined;
	return (
		conversation: string | null,
		status: string,
		rows: readonly AgentRow[]
	): ChimeKind | null => {
		if (conversation === null) {
			previous = undefined;
			return null;
		}
		const pending = new Set(
			rows
				.filter((row) => row.state === 'confirm' || row.tool?.approval !== undefined)
				.map((row) => row.id)
		);
		const before = previous;
		previous = { conversation, running: status === 'running', pending };
		if (before?.conversation !== conversation) return null;
		if ([...pending].some((id) => !before.pending.has(id))) return 'approval';
		return before.running && status === 'idle' ? 'complete' : null;
	};
}

/** Norbius's original soft two-note motif, synthesized locally. No network, loops or autoplay backlog. */
export function createChime(enabled: () => boolean): Chime & { unlock(): void; close(): void } {
	let audio: AudioContext | undefined,
		last = -Infinity;
	return {
		unlock() {
			if (!enabled() || typeof AudioContext === 'undefined') return;
			audio ??= new AudioContext();
			void audio.resume().catch(() => {});
		},
		play(kind) {
			if (!enabled() || audio?.state !== 'running' || performance.now() - last < 10_000) return;
			last = performance.now();
			const start = audio.currentTime;
			const notes = kind === 'approval' ? [440, 554.37] : [554.37, 659.25];
			for (const [index, frequency] of notes.entries()) {
				const at = start + index * 0.13,
					oscillator = audio.createOscillator(),
					gain = audio.createGain();
				oscillator.type = 'sine';
				oscillator.frequency.value = frequency;
				gain.gain.setValueAtTime(0, at);
				gain.gain.linearRampToValueAtTime(0.025, at + 0.015);
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
		},
		close() {
			if (audio !== undefined) void audio.close().catch(() => {});
		}
	};
}
