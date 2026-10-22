<script lang="ts" module>
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import ChatMessageCompaction from '$lib/components/app/chat/ChatMessages/ChatMessage/ChatMessageCompaction/ChatMessageCompaction.svelte';
	import { MessageRole, MessageType } from '$lib/enums';
	import { conversationsStore } from '$lib/stores/conversations/index.svelte';
	import { SUMMARY_CONTENT_PREFIX } from '$lib/services/context';

	const { Story } = defineMeta({
		component: ChatMessageCompaction,
		parameters: {
			layout: 'centered'
		},
		title: 'Components/ChatScreen/ChatMessageCompaction'
	});

	const keptUserMessage: DatabaseMessage = {
		children: [],
		content: 'thanks, that worked',
		convId: 'conv-1',
		id: 'kept-1',
		parent: 'cmp-1',
		role: MessageRole.USER,
		timestamp: Date.now() - 1000 * 60,
		type: MessageType.TEXT
	};

	const compactionMessage: DatabaseMessage = {
		children: ['kept-1'],
		compactionMeta: {
			estimatedTokensBefore: 1840,
			firstKeptMessageId: 'kept-1',
			summarizedCount: 3,
			summaryTokens: 250
		},
		content: `${SUMMARY_CONTENT_PREFIX} The user asked to fix a bug in the auth module. The agent read src/auth.ts, found the off-by-one in the token expiry check, and applied a patch. The user confirmed the fix works.`,
		convId: 'conv-1',
		id: 'cmp-1',
		parent: '3',
		role: MessageRole.USER,
		timestamp: Date.now() - 1000 * 60 * 5,
		type: MessageType.COMPACTION
	};

	const splitKeptAssistant: DatabaseMessage = {
		children: [],
		content: '',
		convId: 'conv-1',
		id: 'asst-2',
		parent: 'cmp-2',
		role: MessageRole.ASSISTANT,
		toolCalls: JSON.stringify([
			{
				function: { arguments: '{}', name: 'read_file' },
				id: 'call_9',
				type: 'function'
			}
		]),
		timestamp: Date.now() - 1000 * 30,
		type: MessageType.TEXT
	};

	const splitCompactionMessage: DatabaseMessage = {
		children: ['asst-2'],
		compactionMeta: {
			estimatedTokensBefore: 900,
			firstKeptMessageId: 'asst-2',
			isSplitTurn: true,
			summarizedCount: 2,
			summaryTokens: 180
		},
		content: `${SUMMARY_CONTENT_PREFIX} (a) Earlier: the user asked to refactor the module; the agent listed the files. (b) In-progress turn: goal = refactor src/parser.ts; read_file done on parser.ts; next step = edit_file.`,
		convId: 'conv-1',
		id: 'cmp-2',
		parent: 'asst-1',
		role: MessageRole.USER,
		timestamp: Date.now() - 1000 * 30,
		type: MessageType.COMPACTION
	};

	async function setPath(messages: DatabaseMessage[]) {
		conversationsStore.activeMessages = messages;
	}

	async function expandEntry() {
		const button = document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');

		if (button) await button.click();
	}
</script>

<Story
	args={{
		class: 'w-[36rem]',
		message: compactionMessage
	}}
	name="Collapsed"
	play={async () => {
		await setPath([compactionMessage, keptUserMessage]);
	}}
/>

<Story
	args={{
		class: 'w-[36rem]',
		message: compactionMessage
	}}
	name="Expanded"
	play={async () => {
		await setPath([compactionMessage, keptUserMessage]);
		await expandEntry();
	}}
/>

<Story
	args={{
		class: 'w-[36rem]',
		message: compactionMessage
	}}
	name="BoundaryLost"
	play={async () => {
		// The boundary message is gone from the path (deleted/branched away):
		// the builder fails open to a full send, the row says so.
		await setPath([compactionMessage]);
		await expandEntry();
	}}
/>

<Story
	args={{
		class: 'w-[36rem]',
		message: splitCompactionMessage
	}}
	name="SplitTurn"
	play={async () => {
		await setPath([splitCompactionMessage, splitKeptAssistant]);
		await expandEntry();
	}}
/>
