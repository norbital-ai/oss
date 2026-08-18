<script lang="ts">
	let {
		disabled = false,
		placeholder = 'Message the agent',
		onsend
	}: {
		disabled?: boolean;
		placeholder?: string;
		onsend?: (message: string) => void;
	} = $props();
	let message = $state('');
</script>

<form aria-label="Agent message" onsubmit={(event) => {
	event.preventDefault();
	const value = message.trim();
	if (!disabled && value !== '') {
		onsend?.(value);
		message = '';
	}
}}>
	<label for="bolt-agent-message">Message</label>
	<textarea
		id="bolt-agent-message"
		aria-describedby="bolt-agent-message-help"
		bind:value={message}
		{disabled}
		{placeholder}
		onkeydown={(event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				event.currentTarget.form?.requestSubmit();
			}
		}}
	></textarea>
	<div class="composer-actions">
		<small id="bolt-agent-message-help">Enter to send · Shift+Enter for a new line</small>
		<button type="submit" disabled={disabled || message.trim() === ''}>
			{disabled ? 'Working…' : 'Send'}
		</button>
	</div>
</form>

<style>
	form { display: grid; gap: .5rem; }
	label { font-weight: 600; }
	textarea { min-height: 5rem; resize: vertical; }
	.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
</style>
