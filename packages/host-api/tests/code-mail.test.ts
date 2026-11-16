import { expect, it } from 'vitest';
import { code_mail } from '../src/code-mail.ts';

it('identifies the destination in every email representation and escapes its HTML', () => {
	const mail = code_mail('123456', 'Example <lab> & coating');
	expect(mail.subject).toBe('Your Norbital code for Example <lab> & coating: 123456');
	expect(mail.text).toContain('for Example <lab> & coating');
	expect(mail.html).toContain('for Example &lt;lab&gt; &amp; coating');
	expect(mail.html).not.toContain('Example <lab>');
	expect(mail.text).toContain('expires in 10 minutes');
	expect(code_mail('123456', 'Lab\r\nNorth').subject).not.toMatch(/[\r\n]/);
});

it('keeps the generic wording when no destination is known', () => {
	expect(code_mail('123456').subject).toBe('Your Norbital code: 123456');
});
