/* global toastr */
import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

// Native Anthropic SSE, forwarded unchanged by the server. `message_start` carries a
// top-level `message` object, which is a normal event and not an error payload.
const claudeEvents = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test', usage: { input_tokens: 5, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ['message_stop', { type: 'message_stop' }],
];

const toSse = events => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test.describe('Claude native streaming', () => {
    test.beforeEach(testSetup.awaitST);

    test('streams a normal Claude response that starts with message_start', async ({ page }) => {
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: toSse(claudeEvents),
        }));
        const result = await page.evaluate(async () => {
            const { sendOpenAIRequest, oai_settings } = await import('./scripts/openai.js');
            const original = { source: oai_settings.chat_completion_source, stream: oai_settings.stream_openai };
            oai_settings.chat_completion_source = 'claude';
            oai_settings.stream_openai = true;
            const toasts = [];
            const originalToast = toastr.error;
            toastr.error = (...args) => { toasts.push(String(args[0])); };
            try {
                const generator = await sendOpenAIRequest('normal', [{ role: 'user', content: 'hi' }]);
                let text = '';
                let error = null;
                try {
                    for await (const chunk of generator()) text = chunk.text;
                } catch (e) {
                    error = String(e?.message ?? e);
                }
                return { text, error, toasts };
            } finally {
                toastr.error = originalToast;
                oai_settings.chat_completion_source = original.source;
                oai_settings.stream_openai = original.stream;
            }
        });
        expect(result.error).toBeNull();
        expect(result.toasts).toEqual([]);
        expect(result.text).toBe('Hello there');
    });

    test('still surfaces a Claude error event mid-stream', async ({ page }) => {
        const events = [
            claudeEvents[0],
            claudeEvents[3],
            ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
        ];
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
            body: toSse(events),
        }));
        const result = await page.evaluate(async () => {
            const { sendOpenAIRequest, oai_settings } = await import('./scripts/openai.js');
            const original = { source: oai_settings.chat_completion_source, stream: oai_settings.stream_openai };
            oai_settings.chat_completion_source = 'claude';
            oai_settings.stream_openai = true;
            const toasts = [];
            const originalToast = toastr.error;
            toastr.error = (...args) => { toasts.push(String(args[0])); };
            try {
                const generator = await sendOpenAIRequest('normal', [{ role: 'user', content: 'hi' }]);
                let error = null;
                try {
                    for await (const chunk of generator()) void chunk;
                } catch (e) {
                    error = String(e?.message ?? e);
                }
                return { error, toasts };
            } finally {
                toastr.error = originalToast;
                oai_settings.chat_completion_source = original.source;
                oai_settings.stream_openai = original.stream;
            }
        });
        expect(result.error).toBe('Overloaded');
        expect(result.toasts).toEqual(['Overloaded']);
    });
});
