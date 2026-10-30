import { describe, expect, test } from '@jest/globals';
import { getMessageDepth } from '../public/scripts/message-depth.js';

function originalDepth(chat, messageId) {
    const usableMessages = chat.map((message, index) => ({ message, index })).filter(x => !x.message.is_system);
    const indexOf = usableMessages.findIndex(x => x.index === Number(messageId));
    return messageId >= 0 && indexOf !== -1 ? usableMessages.length - indexOf - 1 : undefined;
}

describe('display regex message depth', () => {
    test('preserves the old depth for every position with interleaved system messages', () => {
        const messages = Array.from({ length: 100 }, (_, i) => ({ is_system: i % 3 === 0 }));
        for (let i = -1; i <= messages.length; i++) {
            expect(getMessageDepth(messages, i)).toBe(originalDepth(messages, i));
            expect(getMessageDepth(messages, String(i))).toBe(originalDepth(messages, String(i)));
        }
    });

    test('handles empty chats, missing positions, invalid IDs and transient output', () => {
        const messages = [{}, {}, { is_system: true }, {}];
        delete messages[1];
        for (const id of [-1, 0, 1, 2, 3, 4, 1.5, 'invalid', undefined, null, '', Infinity]) {
            expect(getMessageDepth(messages, id)).toBe(originalDepth(messages, id));
        }
        expect(getMessageDepth([], 0)).toBeUndefined();
    });

    test('reflects appended, removed and hidden messages without stale cached depths', () => {
        const messages = [{}, {}, {}];
        expect(getMessageDepth(messages, 0)).toBe(2);
        messages[1].is_system = true;
        expect(getMessageDepth(messages, 0)).toBe(1);
        messages.push({});
        expect(getMessageDepth(messages, 0)).toBe(2);
        messages.splice(1, 2);
        expect(getMessageDepth(messages, 0)).toBe(1);
    });

    test('rendering the last 100 messages inspects only their tail, not the full 5000-message history', () => {
        let reads = 0;
        const messages = Array.from({ length: 5000 }, () => ({ get is_system() { reads++; return false; } }));
        for (let i = 4900; i < 5000; i++) getMessageDepth(messages, i);
        expect(reads).toBe(5050);
        reads = 0;
        for (let i = 4900; i < 5000; i++) originalDepth(messages, i);
        expect(reads).toBe(500000);
    });

    test('streaming the last message does constant work independent of total chat length', () => {
        let reads = 0;
        const messages = Array.from({ length: 5000 }, () => ({ get is_system() { reads++; return false; } }));
        for (let i = 0; i < 200; i++) expect(getMessageDepth(messages, 4999)).toBe(0);
        expect(reads).toBe(200);
    });
});
