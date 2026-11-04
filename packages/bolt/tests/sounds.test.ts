import { afterEach, expect, it, vi } from 'vitest';
import { createSounds, noticeArrivals } from '../src/shell/sounds.ts';

class BrowserAudio {
	static instances: BrowserAudio[] = [];
	state = 'suspended';
	currentTime = 0;
	destination = {};
	onstatechange: (() => void) | null = null;
	constructor() {
		BrowserAudio.instances.push(this);
	}
	resume = vi.fn(async () => {
		this.state = 'running';
		this.onstatechange?.();
	});
	close = vi.fn(async () => {
		this.state = 'closed';
	});
	createOscillator = vi.fn(() => ({
		type: 'sine',
		frequency: { value: 0 },
		connect: vi.fn(),
		disconnect: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		onended: null
	}));
	createGain = vi.fn(() => ({
		gain: {
			setValueAtTime: vi.fn(),
			linearRampToValueAtTime: vi.fn(),
			exponentialRampToValueAtTime: vi.fn()
		},
		connect: vi.fn(),
		disconnect: vi.fn()
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
	BrowserAudio.instances = [];
});

it('never creates audio when disabled, and never replays events dropped before unlock', async () => {
	vi.stubGlobal('AudioContext', BrowserAudio);
	let enabled = false;
	const sounds = createSounds(() => enabled, vi.fn());
	await sounds.test();
	expect(BrowserAudio.instances).toHaveLength(0);
	enabled = true;
	sounds.play('notification');
	await sounds.unlock();
	const audio = BrowserAudio.instances[0]!;
	expect(audio.createOscillator).not.toHaveBeenCalled();
	sounds.play('notification');
	expect(audio.createOscillator).toHaveBeenCalledTimes(2);
	enabled = false;
	sounds.play('input');
	expect(audio.createOscillator).toHaveBeenCalledTimes(2);
	sounds.close();
	expect(audio.close).toHaveBeenCalledOnce();
});

it('reports blocked audio, recovers on a later gesture, and reflects browser suspension', async () => {
	vi.stubGlobal('AudioContext', BrowserAudio);
	const changed = vi.fn();
	const sounds = createSounds(() => true, changed);
	await sounds.unlock();
	const audio = BrowserAudio.instances[0]!;
	audio.state = 'suspended';
	audio.resume.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
	await sounds.test();
	expect(changed).toHaveBeenLastCalledWith('blocked');
	expect(audio.createOscillator).not.toHaveBeenCalled();
	await sounds.test();
	expect(changed).toHaveBeenLastCalledWith('ready');
	expect(audio.createOscillator).toHaveBeenCalledTimes(2);
	audio.state = 'suspended';
	audio.onstatechange?.();
	expect(changed).toHaveBeenLastCalledWith('blocked');
	sounds.close();
});

it('reports unsupported audio and device initialization failure without throwing', async () => {
	const changed = vi.fn();
	vi.stubGlobal('AudioContext', undefined);
	await createSounds(() => true, changed).test();
	expect(changed).toHaveBeenLastCalledWith('unavailable');
	vi.stubGlobal(
		'AudioContext',
		class {
			constructor() {
				throw new Error('Device unavailable');
			}
		}
	);
	await createSounds(() => true, changed).test();
	expect(changed).toHaveBeenLastCalledWith('blocked');
});

it('coalesces repeated events without letting Norbius suppress notifications or the test button', async () => {
	vi.stubGlobal('AudioContext', BrowserAudio);
	const sounds = createSounds(() => true, vi.fn());
	await sounds.unlock();
	sounds.play('complete');
	sounds.play('notification');
	sounds.play('notification');
	expect(BrowserAudio.instances[0]!.createOscillator).toHaveBeenCalledTimes(4);
	await sounds.test();
	await sounds.test();
	expect(BrowserAudio.instances[0]!.createOscillator).toHaveBeenCalledTimes(8);
	sounds.close();
	await sounds.test();
	sounds.play('input');
	expect(BrowserAudio.instances[0]!.createOscillator).toHaveBeenCalledTimes(8);
});

it('plays a distinct quiet pair for each event: finished, needs input, error, notification', async () => {
	vi.stubGlobal('AudioContext', BrowserAudio);
	const sounds = createSounds(() => true, vi.fn());
	const pairs: number[][] = [];
	await sounds.unlock();
	for (const kind of ['complete', 'input', 'error', 'notification'] as const) {
		sounds.play(kind);
		const audio = BrowserAudio.instances[0]!;
		pairs.push(audio.createOscillator.mock.results.slice(-2).map((r) => r.value.frequency.value));
	}
	expect(new Set(pairs.map((pair) => pair.join())).size).toBe(4);
	// the error falls; the others rise
	expect(pairs[2]![0]!).toBeGreaterThan(pairs[2]![1]!);
	for (const index of [0, 1, 3]) expect(pairs[index]![0]!).toBeLessThan(pairs[index]![1]!);
	const peaks = BrowserAudio.instances[0]!.createGain.mock.results.map(
		(r) => r.value.gain.linearRampToValueAtTime.mock.calls[0]![0]
	);
	expect(Math.max(...peaks)).toBeLessThanOrEqual(0.03);
	sounds.close();
});

it('only chimes for newly arriving unread notices, never initial history or read-state changes', () => {
	const arrived = noticeArrivals();
	const old = { id: 'old', read: false, at: '2026-11-03T01:00:00Z' };
	expect(arrived([old])).toBe(false);
	expect(arrived([{ ...old, read: true }])).toBe(false);
	expect(arrived([old])).toBe(false);
	const next = { ...old, id: 'next', at: '2026-11-03T01:01:00Z' };
	expect(arrived([next, old])).toBe(true);
	expect(arrived([next, old])).toBe(false);
	expect(arrived([next, { ...old, id: 'older', at: '2026-11-02T01:00:00Z' }])).toBe(false);
	expect(arrived([next, { ...next, id: 'same-time' }])).toBe(true);
});
