import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({ delay: async () => {} }));
const { default: EventSourceStream } = await import('../public/scripts/sse-stream.js');

async function parse(text, chunkSize = Infinity) {
    const stream = new EventSourceStream();
    const writer = stream.writable.getWriter();
    const events = [];
    const reading = (async () => {
        for await (const event of stream.readable) events.push({ type: event.type, data: event.data, id: event.lastEventId });
    })();
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += chunkSize) await writer.write(bytes.slice(i, i + chunkSize));
    await writer.close();
    await reading;
    return events;
}

describe('Chat Completion SSE parsing', () => {
    test('ignores comments which contain data or event field names', async () => {
        expect(await parse(':data: heartbeat\n:event: error\n\ndata: {"choices":[]}\n\n')).toEqual([
            { type: 'message', data: '{"choices":[]}', id: '' },
        ]);
    });

    test.each(['\n', '\r\n', '\r'])('preserves multiline data, event types and IDs with %j line endings', async newline => {
        const text = ['id: 1', 'event: token', 'data: first', 'data: second', '', 'data: [DONE]', '', ''].join(newline);
        // eslint-disable-next-line playwright/no-standalone-expect -- Jest test.each callback
        expect(await parse(text)).toEqual([
            { type: 'token', data: 'first\nsecond', id: '1' },
            { type: 'message', data: '[DONE]', id: '1' },
        ]);
    });

    test('handles UTF-8 characters and CRLF delimiters fragmented across network chunks', async () => {
        expect(await parse(':data: ignored\r\n\r\ndata: {"content":"Hello 😀"}\r\n\r\n', 1)).toEqual([
            { type: 'message', data: '{"content":"Hello 😀"}', id: '' },
        ]);
    });

    test('retains valid IDs, permits empty IDs, and discards incomplete final events', async () => {
        expect(await parse('id: original\n\nid: bad\0id\ndata: ok\n\nid:\ndata: next\n\ndata: incomplete')).toEqual([
            { type: 'message', data: 'ok', id: 'original' },
            { type: 'message', data: 'next', id: '' },
        ]);
    });
});
