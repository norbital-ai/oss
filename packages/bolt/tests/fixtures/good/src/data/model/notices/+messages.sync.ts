import { sync } from '@norbital-ai/bolt';

export default sync('notices', 'messages', {
	with: 'mail',
	read: function* () {
		return { rows: [] };
	}
});
