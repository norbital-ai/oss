import { describe, expect, it } from 'vitest';
import { cn } from '../src/primitives/utils.js';

describe('cn', () => {
	it('preserves custom typography scale & role tokens alongside text colors', () => {
		expect(cn('text-micro text-foreground')).toBe('text-micro text-foreground');
		expect(cn('text-tiny text-muted-foreground')).toBe('text-tiny text-muted-foreground');
		expect(cn('text-overline text-foreground')).toBe('text-overline text-foreground');
		expect(cn('text-heading text-destructive')).toBe('text-heading text-destructive');
	});

	it('still resolves conflicts between font-size tokens', () => {
		expect(cn('text-sm', 'text-micro')).toBe('text-micro');
		expect(cn('text-micro', 'text-tiny')).toBe('text-tiny');
	});
});
