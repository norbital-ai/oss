import { describe, expect, it } from 'vitest';
import {
	isSandboxWaitResult,
	sameSandbox,
	sandboxFromSession,
	sandboxKey
} from '$lib/server/agent/sandbox-agents.server.js';

describe('agent sandbox identity', () => {
	it('keys personal sessions by the requestor, not by a guessed peer', () => {
		const ada = sandboxFromSession({ user_id: 'user-ada', channel_key: null });
		const bea = sandboxFromSession({ user_id: 'user-bea', channel_key: null });
		expect(sandboxKey(ada)).toBe('user:user-ada');
		expect(sameSandbox(ada, bea)).toBe(false);
		expect(sameSandbox(ada, sandboxFromSession({ user_id: 'user-ada', channel_key: null }))).toBe(
			true
		);
	});

	it('keys channel sessions by profile, even when a DM is attached to a human', () => {
		const whatsapp = sandboxFromSession({
			user_id: 'user-ada',
			channel_key: 'whatsapp_desk'
		});
		const adaWeb = sandboxFromSession({ user_id: 'user-ada', channel_key: null });
		const otherWhatsapp = sandboxFromSession({
			user_id: 'user-bea',
			channel_key: 'whatsapp_desk'
		});
		const telegram = sandboxFromSession({
			user_id: 'user-ada',
			channel_key: 'telegram_desk'
		});
		expect(sandboxKey(whatsapp)).toBe('channel:whatsapp_desk');
		expect(sameSandbox(whatsapp, adaWeb)).toBe(false);
		expect(sameSandbox(whatsapp, otherWhatsapp)).toBe(true);
		expect(sameSandbox(whatsapp, telegram)).toBe(false);
	});
});

describe('sandbox wait result', () => {
	it('only treats an explicit parked wait as a stop', () => {
		expect(isSandboxWaitResult({ resultType: 'sandbox_wait', waiting: true })).toBe(true);
		expect(isSandboxWaitResult({ resultType: 'sandbox_wait', waiting: false })).toBe(false);
		expect(isSandboxWaitResult({ status: 'settled' })).toBe(false);
	});
});
