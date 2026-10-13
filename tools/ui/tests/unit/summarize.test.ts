// buildSummaryTranscript: the plain-text transcript fed to the summary call.
// Attachments must become placeholders (never base64), tool calls reduce to
// their names, and empty messages drop out entirely.

import { AttachmentType, MessageRole, MessageType } from '$lib/enums';
import { buildSummaryTranscript } from '$lib/services/context/summarize';
import type { DatabaseMessage } from '$lib/types/database';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/services/chat.service', () => ({
	ChatService: {
		normalizeMessagesForApi: vi.fn(),
		sendMessage: vi.fn()
	}
}));

function message(role: MessageRole, content: string, extra?: Partial<DatabaseMessage>): DatabaseMessage {
	return {
		children: [],
		content,
		convId: 'c1',
		id: `m${Math.random()}`,
		parent: null,
		role,
		timestamp: 0,
		type: MessageType.TEXT,
		...extra
	} as DatabaseMessage;
}

describe('buildSummaryTranscript', () => {
	it('renders each message as [role] content', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.USER, 'fix the login bug'),
			message(MessageRole.ASSISTANT, 'on it — checking auth.ts')
		]);

		expect(transcript).toBe('[user] fix the login bug\n\n[assistant] on it — checking auth.ts');
	});

	it('reduces tool calls to their names', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, '', {
				toolCalls: JSON.stringify([
					{ function: { name: 'read_file' }, id: 'c1' },
					{ function: { name: 'write_file' }, id: 'c2' }
				])
			}),
			message(MessageRole.TOOL, 'file content here', { toolCallId: 'c1' })
		]);

		expect(transcript).toContain('[tool_calls: read_file, write_file]');
		expect(transcript).toContain('[tool] file content here');
	});

	it('uses a generic placeholder for malformed toolCalls JSON', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, 'doing things', { toolCalls: '{not-json' })
		]);

		expect(transcript).toContain('[tool_calls: unparsed]');
	});

	it('turns attachments into placeholders without base64', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.USER, 'see the screenshot', {
				extra: [
					{ base64Url: 'data:image/jpeg;base64,SECRET', name: 'shot.jpg', type: AttachmentType.IMAGE },
					{ content: 'const a = 1;', name: 'x.ts', size: 1234, type: AttachmentType.TEXT },
					{
						content: 'pdf text',
						images: ['data:image/png;base64,a', 'data:image/png;base64,b'],
						name: 'doc.pdf',
						processedAsImages: true,
						type: AttachmentType.PDF
					},
					{ base64Data: 'SECRET', mimeType: 'audio/mpeg', name: 'note.mp3', type: AttachmentType.AUDIO }
				]
			})
		]);

		expect(transcript).toContain('[image: shot.jpg]');
		expect(transcript).toContain('[file: x.ts, 1.21 KB]');
		expect(transcript).toContain('[pdf: doc.pdf, 2 pages as images]');
		expect(transcript).toContain('[audio: note.mp3]');
		expect(transcript).not.toContain('SECRET');
	});

	it('drops empty messages and joins the rest with blank lines', () => {
		const transcript = buildSummaryTranscript([
			message(MessageRole.ASSISTANT, ''),
			message(MessageRole.USER, 'hello'),
			message(MessageRole.ASSISTANT, 'world')
		]);

		expect(transcript).toBe('[user] hello\n\n[assistant] world');
	});

	it('returns an empty string for an empty region', () => {
		expect(buildSummaryTranscript([])).toBe('');
	});
});
