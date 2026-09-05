import { describe, expect, it, vi } from 'vitest';
import { Schema } from 'effect';
import {
	AUTHORING_LIVE_EVENT_SOURCE_INIT,
	AUTHORING_LIVE_SSE_EVENT,
	AUTHORING_LOG_LINE_MAX_CHARS,
	AUTHORING_LOG_RING,
	applyAuthoringLiveEvent,
	authoringJobBusy,
	authoringLogTone,
	AuthoringLiveEvent,
	clipAuthoringLogLine,
	diagnosisFindingTone,
	emptyAuthoringLiveState,
	openAuthoringLiveStream,
	type AuthoringEventSourceInit,
	type AuthoringLiveState
} from '../src/client/ui/studio/authoring-live.js';

const COLONY_AUTHORING_STREAM_URL = '/__colony/api/authoring/stream';

const authoringSseBlock = (event: unknown): string =>
	`event: ${AUTHORING_LIVE_SSE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;

/** Browser EventSource: `event:` is the listener name; `: keepalive` has no data. */
class FakeAuthoringEventSource {
	readonly url: string;
	readonly withCredentials: boolean;
	private readonly listeners = new Map<string, Array<(event: { data: string }) => void>>();
	private closed = false;

	constructor(url: string, init?: AuthoringEventSourceInit) {
		this.url = url;
		this.withCredentials = init?.withCredentials === true;
	}

	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
	}

	close(): void {
		this.closed = true;
		this.listeners.clear();
	}

	isClosed(): boolean {
		return this.closed;
	}

	listenerTypes(): ReadonlyArray<string> {
		return [...this.listeners.keys()];
	}

	pushSse(block: string): void {
		if (this.closed) return;
		let eventName = 'message';
		const dataLines: string[] = [];
		for (const line of block.split('\n')) {
			if (line.startsWith(':')) continue;
			if (line.startsWith('event:')) {
				eventName = line.slice('event:'.length).trim();
				continue;
			}
			if (line.startsWith('data:')) {
				dataLines.push(line.slice('data:'.length).trimStart());
			}
		}
		if (dataLines.length === 0) return;
		for (const listener of this.listeners.get(eventName) ?? []) {
			listener({ data: dataLines.join('\n') });
		}
	}
}

describe('Studio authoring live fold', () => {
	it('admits a source invalidation without altering the running job or log state', () => {
		const state = emptyAuthoringLiveState();
		const event = Schema.decodeUnknownSync(AuthoringLiveEvent)({
			kind: 'source',
			tenantId: 'tenant-a',
			workspaceKey: 'person-a',
			commit: 'new-source-commit',
			at: '2026-09-05T08:30:00.000Z'
		});
		expect(applyAuthoringLiveEvent(state, event)).toBe(state);
	});
	it('colors captured log lines by level after ANSI is stripped', () => {
		expect(authoringLogTone('error')).toBe('danger');
		expect(authoringLogTone('stderr')).toBe('danger');
		expect(authoringLogTone('warning')).toBe('warning');
		expect(authoringLogTone('warn')).toBe('warning');
		expect(authoringLogTone('hint')).toBe('info');
		expect(authoringLogTone('info')).toBe('info');
		expect(authoringLogTone('log')).toBe('default');
	});

	it('advances diagnose → preview → merge phases without a snapshot re-read', () => {
		let state = emptyAuthoringLiveState();
		for (const phase of ['prepare', 'checks', 'publish', 'provision', 'complete'] as const) {
			state = applyAuthoringLiveEvent(state, {
				kind: 'phase',
				tenantId: 'tenant-a',
				job: 'preview',
				phase,
				at: `2026-09-02T15:00:0${phase === 'complete' ? '5' : '0'}.000Z`
			});
		}
		expect(state.job).toEqual({
			action: 'preview',
			phase: 'complete',
			at: '2026-09-02T15:00:05.000Z'
		});
		expect(authoringJobBusy(state)).toBe(false);
		state = applyAuthoringLiveEvent(state, {
			kind: 'phase',
			tenantId: 'tenant-a',
			job: 'merge',
			phase: 'prepare',
			at: '2026-09-02T15:01:00.000Z'
		});
		expect(authoringJobBusy(state)).toBe(true);
		expect(state.job?.action).toBe('merge');
	});

	it('appends pushed log lines, clips at 800, and rings at 256', () => {
		let state = emptyAuthoringLiveState();
		state = applyAuthoringLiveEvent(state, {
			kind: 'log',
			tenantId: 'tenant-a',
			job: 'publish',
			stream: 'build',
			level: 'log',
			line: 'x'.repeat(AUTHORING_LOG_LINE_MAX_CHARS + 40),
			at: '2026-09-02T15:00:00.000Z'
		});
		expect(state.logs[0]?.line).toHaveLength(AUTHORING_LOG_LINE_MAX_CHARS);
		expect(clipAuthoringLogLine('ok')).toBe('ok');

		for (let index = 0; index < AUTHORING_LOG_RING + 3; index += 1) {
			state = applyAuthoringLiveEvent(state, {
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'deploy',
				stream: 'guest',
				level: 'log',
				line: `ring-${index}`,
				at: `2026-09-02T15:00:${String(index % 60).padStart(2, '0')}.000Z`
			});
		}
		expect(state.logs).toHaveLength(AUTHORING_LOG_RING);
		expect(state.logs[0]?.line).toBe('ring-3');
		expect(state.logs.at(-1)?.line).toBe(`ring-${AUTHORING_LOG_RING + 2}`);
	});

	it('keeps the latest workbench RAM sample for the monitor', () => {
		let state = emptyAuthoringLiveState();
		state = applyAuthoringLiveEvent(state, {
			kind: 'memory',
			tenantId: 'tenant-a',
			workspaceKey: 'development:user:author-one',
			rssMiB: 412,
			limitMiB: 2048,
			at: '2026-09-02T15:00:00.000Z'
		});
		state = applyAuthoringLiveEvent(state, {
			kind: 'memory',
			tenantId: 'tenant-a',
			workspaceKey: 'development:user:author-one',
			rssMiB: 880,
			limitMiB: 2048,
			at: '2026-09-02T15:00:05.000Z'
		});
		expect(state.memory).toEqual({
			workspaceKey: 'development:user:author-one',
			rssMiB: 880,
			limitMiB: 2048,
			at: '2026-09-02T15:00:05.000Z'
		});
		expect(state.memory !== null && state.memory.rssMiB < state.memory.limitMiB).toBe(true);
	});

	it('accumulates comments and decisions from two admins on one MR', () => {
		let state = emptyAuthoringLiveState();
		state = applyAuthoringLiveEvent(state, {
			kind: 'comment',
			tenantId: 'tenant-a',
			requestId: 'mr-14',
			by: 'author-one',
			body: 'preview looks right on Jul 3',
			at: '2026-09-02T15:02:00.000Z'
		});
		state = applyAuthoringLiveEvent(state, {
			kind: 'comment',
			tenantId: 'tenant-a',
			requestId: 'mr-14',
			by: 'author-two',
			body: 'approved after checking the fork',
			at: '2026-09-02T15:03:00.000Z'
		});
		state = applyAuthoringLiveEvent(state, {
			kind: 'decision',
			tenantId: 'tenant-a',
			requestId: 'mr-14',
			decision: 'approved',
			by: 'author-two',
			at: '2026-09-02T15:03:01.000Z'
		});
		expect(state.comments.map((row) => row.by)).toEqual(['author-one', 'author-two']);
		expect(state.decisions).toEqual([
			{
				requestId: 'mr-14',
				decision: 'approved',
				by: 'author-two',
				at: '2026-09-02T15:03:01.000Z'
			}
		]);
	});

	it('colors diagnosis findings by severity', () => {
		expect(diagnosisFindingTone('error')).toBe('danger');
		expect(diagnosisFindingTone('warning')).toBe('warning');
		expect(diagnosisFindingTone('hint')).toBe('info');
	});

	it('decodes a pushed frame and refuses a poll-shaped payload', () => {
		const frame = Schema.decodeUnknownSync(AuthoringLiveEvent)({
			kind: 'phase',
			tenantId: 'tenant-a',
			job: 'publish',
			phase: 'checks',
			at: '2026-09-02T15:00:00.000Z'
		});
		expect(frame.kind).toBe('phase');
		expect(() =>
			Schema.decodeUnknownSync(AuthoringLiveEvent)({
				kind: 'poll',
				intervalMs: 1_000
			})
		).toThrow();
	});

	it('folds frames pushed after subscribe and ignores another tenant', () => {
		const opened: FakeAuthoringEventSource[] = [];
		const received: string[] = [];
		const stop = openAuthoringLiveStream({
			url: COLONY_AUTHORING_STREAM_URL,
			tenantId: 'tenant-a',
			source: (url, init) => {
				const fake = new FakeAuthoringEventSource(url, init);
				opened.push(fake);
				return fake;
			},
			onEvent: (event) => {
				if (event.kind === 'log') received.push(event.line);
			}
		});
		expect(opened).toHaveLength(1);
		opened[0]?.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'preview',
				stream: 'build',
				level: 'log',
				line: 'checks started',
				at: '2026-09-02T15:00:00.000Z'
			})
		);
		opened[0]?.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-b',
				job: 'preview',
				stream: 'build',
				level: 'log',
				line: 'foreign tenant',
				at: '2026-09-02T15:00:01.000Z'
			})
		);
		expect(received).toEqual(['checks started']);
		stop();
	});
});

describe('Studio authoring live EventSource', () => {
	it('constructs EventSource with credentials on GET /__colony/api/authoring/stream', () => {
		const constructed: Array<{
			readonly url: string;
			readonly init: AuthoringEventSourceInit | undefined;
		}> = [];
		class StubEventSource {
			constructor(url: string, init?: AuthoringEventSourceInit) {
				constructed.push({ url, init });
			}
			addEventListener(): void {}
			close(): void {}
		}
		vi.stubGlobal('EventSource', StubEventSource);
		const stop = openAuthoringLiveStream({
			url: COLONY_AUTHORING_STREAM_URL,
			tenantId: 'tenant-a',
			onEvent: () => undefined
		});
		expect(constructed).toEqual([
			{ url: COLONY_AUTHORING_STREAM_URL, init: AUTHORING_LIVE_EVENT_SOURCE_INIT }
		]);
		stop();
	});

	it('subscribes first, then folds phase/log/memory/comment/decision and refuses poll', () => {
		const opened: FakeAuthoringEventSource[] = [];
		let state = emptyAuthoringLiveState();
		const kinds: Array<AuthoringLiveEvent['kind']> = [];
		const stop = openAuthoringLiveStream({
			url: COLONY_AUTHORING_STREAM_URL,
			tenantId: 'tenant-a',
			source: (url, init) => {
				const fake = new FakeAuthoringEventSource(url, init);
				opened.push(fake);
				return fake;
			},
			onEvent: (event) => {
				kinds.push(event.kind);
				state = applyAuthoringLiveEvent(state, event);
			}
		});

		expect(opened).toHaveLength(1);
		const source = opened[0];
		if (source === undefined) throw new Error('expected one EventSource after subscribe');
		expect(source.url).toBe(COLONY_AUTHORING_STREAM_URL);
		expect(source.withCredentials).toBe(true);
		expect(source.listenerTypes()).toEqual([AUTHORING_LIVE_SSE_EVENT]);
		expect(state).toEqual(emptyAuthoringLiveState());
		expect(kinds).toEqual([]);

		source.pushSse(': keepalive\n\n');
		expect(state).toEqual(emptyAuthoringLiveState());

		source.pushSse(
			authoringSseBlock({
				kind: 'phase',
				tenantId: 'tenant-a',
				job: 'diagnose',
				phase: 'prepare',
				at: '2026-09-02T15:00:00.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'memory',
				tenantId: 'tenant-a',
				workspaceKey: 'development:user:author-one',
				rssMiB: 412,
				limitMiB: 2048,
				at: '2026-09-02T15:00:01.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'phase',
				tenantId: 'tenant-a',
				job: 'publish',
				phase: 'complete',
				at: '2026-09-02T15:00:02.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'publish',
				stream: 'build',
				level: 'log',
				line: 'built',
				at: '2026-09-02T15:00:03.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'merge',
				stream: 'deploy',
				level: 'log',
				line: 'deployed guest',
				at: '2026-09-02T15:00:04.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'comment',
				tenantId: 'tenant-a',
				requestId: 'mr-14',
				by: 'author-one',
				body: 'preview looks right',
				at: '2026-09-02T15:00:05.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'decision',
				tenantId: 'tenant-a',
				requestId: 'mr-14',
				decision: 'approved',
				by: 'author-two',
				at: '2026-09-02T15:00:06.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-b',
				job: 'publish',
				stream: 'build',
				level: 'log',
				line: 'foreign tenant',
				at: '2026-09-02T15:00:07.000Z'
			})
		);
		source.pushSse(
			authoringSseBlock({
				kind: 'poll',
				intervalMs: 1_000
			})
		);
		source.pushSse(
			`data: ${JSON.stringify({
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'publish',
				stream: 'build',
				level: 'log',
				line: 'default message event',
				at: '2026-09-02T15:00:08.000Z'
			})}\n\n`
		);
		source.pushSse(`event: ${AUTHORING_LIVE_SSE_EVENT}\ndata: not-json\n\n`);

		const beforeClose: AuthoringLiveState = state;
		expect(kinds).toEqual(['phase', 'memory', 'phase', 'log', 'log', 'comment', 'decision']);
		expect(state.job).toEqual({
			action: 'publish',
			phase: 'complete',
			at: '2026-09-02T15:00:02.000Z'
		});
		expect(state.logs.map((row) => ({ stream: row.stream, line: row.line }))).toEqual([
			{ stream: 'build', line: 'built' },
			{ stream: 'deploy', line: 'deployed guest' }
		]);
		expect(state.memory?.rssMiB).toBe(412);
		expect(state.comments.map((row) => row.by)).toEqual(['author-one']);
		expect(state.decisions).toEqual([
			{
				requestId: 'mr-14',
				decision: 'approved',
				by: 'author-two',
				at: '2026-09-02T15:00:06.000Z'
			}
		]);

		stop();
		expect(source.isClosed()).toBe(true);
		source.pushSse(
			authoringSseBlock({
				kind: 'log',
				tenantId: 'tenant-a',
				job: 'deploy',
				stream: 'deploy',
				level: 'log',
				line: 'after close',
				at: '2026-09-02T15:00:09.000Z'
			})
		);
		expect(state).toEqual(beforeClose);
	});
});
