import { describe, expect, it } from 'vitest';
import {
	TAIL_SLACK_PX,
	atTail,
	createTailFollower,
	transcriptTailSignature
} from '../src/client/ui/agent/transcript-follow.js';
import { projectAgentMessages } from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

/** A scrollport with geometry only; the test grows it the way arriving rows would. */
type GrowingPort = { scrollTop: number; scrollHeight: number; clientHeight: number };
const port = (scrollTop: number, scrollHeight: number, clientHeight = 600): GrowingPort => ({
	scrollTop,
	scrollHeight,
	clientHeight
});

const taskId = '00000000-0000-4000-8000-000000000611';

describe('AGENT-UI5 the transcript follows its tail', () => {
	it('counts a reader within the slack of the end as at the end', () => {
		expect(atTail(port(0, 600))).toBe(true);
		expect(atTail(port(400, 1_000))).toBe(true);
		expect(atTail(port(400 - TAIL_SLACK_PX, 1_000))).toBe(true);
		expect(atTail(port(400 - TAIL_SLACK_PX - 1, 1_000))).toBe(false);
		expect(atTail(port(0, 1_000))).toBe(false);
	});

	it('follows growth while the reader was at the end, from a fresh mount onwards', () => {
		const view = port(0, 600);
		const tail = createTailFollower(() => view);
		expect(tail.pinned).toBe(true);
		view.scrollHeight = 1_400;
		tail.follow();
		expect(view.scrollTop).toBe(1_400);
		view.scrollHeight = 2_000;
		tail.observe();
		tail.follow();
		expect(view.scrollTop).toBe(2_000);
	});

	it('leaves a reader who scrolled up where they are, and resumes once they return', () => {
		const view = port(0, 600);
		const tail = createTailFollower(() => view);
		view.scrollHeight = 2_000;
		tail.follow();
		view.scrollTop = 300;
		tail.observe();
		expect(tail.pinned).toBe(false);
		view.scrollHeight = 3_000;
		tail.follow();
		expect(view.scrollTop).toBe(300);
		view.scrollTop = 3_000 - 600;
		tail.observe();
		expect(tail.pinned).toBe(true);
		view.scrollHeight = 4_000;
		tail.follow();
		expect(view.scrollTop).toBe(4_000);
	});

	it('pins on demand: a conversation switch or an own send returns to the end', () => {
		const view = port(300, 2_000);
		const tail = createTailFollower(() => view);
		tail.observe();
		expect(tail.pinned).toBe(false);
		tail.pin();
		tail.follow();
		expect(view.scrollTop).toBe(2_000);
	});

	it('does nothing without a mounted scrollport', () => {
		const tail = createTailFollower(() => null);
		expect(() => {
			tail.observe();
			tail.follow();
		}).not.toThrow();
		expect(tail.pinned).toBe(true);
	});

	it('changes its signature for every arrival a reader would want to see', () => {
		const rows = (extra: ReadonlyArray<Parameters<typeof canonicalAgentRows>[0][number]>) =>
			projectAgentMessages(
				canonicalAgentRows([{ taskId, message: { role: 'user', content: 'Count them' } }, ...extra])
			);
		const empty = transcriptTailSignature([], false);
		const userOnly = transcriptTailSignature(rows([]), false);
		const pendingSend = transcriptTailSignature(rows([]), true);
		const streaming = transcriptTailSignature(
			rows([
				{
					taskId,
					message: { role: 'assistant', content: [{ type: 'text', text: 'Fifty' }] },
					annotation: { tag: 'generation', callId: 'call', sequence: 0, activeParts: [0] }
				}
			]),
			false
		);
		const moreText = transcriptTailSignature(
			rows([
				{
					taskId,
					message: { role: 'assistant', content: [{ type: 'text', text: 'Fifty-nine' }] },
					annotation: { tag: 'generation', callId: 'call', sequence: 1, activeParts: [0] }
				}
			]),
			false
		);
		const settled = transcriptTailSignature(
			rows([
				{ taskId, message: { role: 'assistant', content: [{ type: 'text', text: 'Fifty-nine' }] } }
			]),
			false
		);
		const toolRow = transcriptTailSignature(
			rows([
				{
					taskId,
					message: {
						role: 'assistant',
						content: [{ type: 'tool-call', id: 'c1', name: 'read_collection', params: {} }]
					}
				}
			]),
			false
		);
		const signatures = [empty, userOnly, pendingSend, streaming, moreText, settled, toolRow];
		expect(new Set(signatures).size).toBe(signatures.length);
		// The same rows fingerprint the same way, so the follower is not driven by identity churn.
		expect(transcriptTailSignature(rows([]), false)).toBe(userOnly);
	});
});
