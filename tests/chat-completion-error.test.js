/* eslint-disable playwright/no-standalone-expect -- Jest parameterized unit tests. */
import { describe, expect, test } from '@jest/globals';
import { parseChatCompletionError } from '../public/scripts/chat-completion-error.js';

describe('Chat Completion streaming errors', () => {
    test.each([
        { error: { message: 'Context length exceeded', code: 'context_length_exceeded' } },
        { error: 'Insufficient balance' },
        { message: 'Provider unavailable' },
        { detail: { error: { message: 'Invalid request' } } },
        { quota_error: true },
    ])('recognizes provider error payload %j', data => {
        expect(parseChatCompletionError(JSON.stringify(data))).toEqual(data);
    });

    test.each([
        '[DONE]', '', '<html>gateway failed</html>', 'null',
        '{"choices":[{"delta":{"content":"Hello"}}]}',
        '{"choices":[{"delta":{"reasoning":"Thinking"}}]}',
        '{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}',
    ])('does not label ordinary data as an API error: %s', data => {
        expect(parseChatCompletionError(data)).toBeNull();
    });
});
