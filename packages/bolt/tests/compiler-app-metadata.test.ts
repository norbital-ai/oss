import { describe, expect, it } from 'vitest';
import { extractAppMetadata, extractGroupMetadata } from '../src/compiler/app-metadata.js';

describe('app metadata', () => {
	it('reads bolt static head tags, and reads no other prefix', () => {
		// A name the platform does not own is not metadata. The compiler used to accept `pod:` beside
		// `bolt:` while templates were converted; they are converted, so a stray prefix now reads as
		// absent rather than silently working.
		const foreign = extractAppMetadata(`
			<svelte:head>
				<title>People</title>
				<meta name="description" content="Employees and employments" />
				<meta name="pod:icon" content="lucide:users" />
			</svelte:head>
		`);
		expect(foreign).toEqual({
			title: 'People',
			description: 'Employees and employments',
			icon: null,
			thumbnail: null,
			banner: null
		});
		const bolt = extractAppMetadata(`
			<title>Desk</title>
			<meta name="bolt:icon" content="lucide:ticket" />
			<meta name="bolt:banner" content="/assets/banner.svg" />
		`);
		expect(bolt.icon).toBe('lucide:ticket');
		expect(bolt.banner).toBe('/assets/banner.svg');
	});

	it('decodes HTML entities in authored titles', () => {
		const meta = extractAppMetadata('<title>Time &amp; Attendance</title>');
		expect(meta.title).toBe('Time & Attendance');
	});

	it('reads label, description, icon and defaultChild from an authored +group.ts', () => {
		const group = extractGroupMetadata(`
			export default group({
				label: 'HR Controller',
				description: 'Everything the HR team runs',
				icon: 'lucide:briefcase-business',
				defaultChild: 'people'
			});
		`);
		expect(group).toEqual({
			label: 'HR Controller',
			// Dropped before, so a group heading on the overview had a title and nothing under it while
			// `+group.ts` had said exactly what the group is for.
			description: 'Everything the HR team runs',
			icon: 'lucide:briefcase-business',
			defaultChild: 'people'
		});
	});
});
