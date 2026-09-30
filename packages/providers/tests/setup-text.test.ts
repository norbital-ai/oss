// Every bundled channel provider speaks both framework locales: its label, each step, each field's label and hint,
// and its test target are English and Chinese (a string is a proper noun kept as is), and each offers a test send.
import { describe, expect, it } from 'vitest';
import type { LocalText, SetupField } from '@norbital-ai/bolt/engine';
import { baileys, discord, mailbox, slack, telegram, twilioWhatsapp, wechat } from '../src/index.ts';

const PROPER = new Set(['AppID', 'AppSecret', 'wx…', 'AC…', 'xoxb-…', '123456789:AA…', 'imap.example.com', 'smtp.example.com']);
const texts = (f: SetupField): LocalText[] => [f.label, ...(f.hint === undefined ? [] : [f.hint]), ...(f.options ?? []).map((o) => o.label)];

describe('provider setup text', () => {
	for (const p of [baileys(), twilioWhatsapp(), telegram(), slack(), discord(), wechat(), ...mailbox()]) it(`${p.transport}/${p.id} has en and zh everywhere, and a test send`, () => {
		const all = [p.label, ...p.setup.steps.map((s) => s.text), ...(p.setup.fields ?? []).flatMap(texts), ...(p.test?.to === undefined ? [] : texts(p.test.to))];
		for (const x of all) {
			if (typeof x === 'string') expect(PROPER).toContain(x);
			else expect(x.zh?.length ?? 0).toBeGreaterThan(0);
		}
		expect(p.test).toBeDefined();
	});
});
