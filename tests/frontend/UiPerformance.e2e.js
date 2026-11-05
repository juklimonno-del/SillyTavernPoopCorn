import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('UI performance without formatting regressions', () => {
    test.beforeEach(testSetup.awaitST);

    test('keeps depth-limited regex behavior across system messages and history edits', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { chat, messageFormatting } = await import('./script.js');
            const { extension_settings } = await import('./scripts/extensions.js');
            const { regex_placement } = await import('./scripts/extensions/regex/engine.js');
            const originalChat = chat.slice();
            const originalRegex = extension_settings.regex;
            const originalDisabled = extension_settings.disabledExtensions;
            try {
                chat.splice(0, chat.length, ...[false, false, true, false].map(is_system => ({ mes: 'TOKEN', name: 'Test', is_user: false, is_system, extra: {} })));
                extension_settings.disabledExtensions = originalDisabled.filter(name => name !== 'regex');
                extension_settings.regex = [{ id: 'depth-test', scriptName: 'Depth test', findRegex: '/TOKEN/g', replaceString: 'MATCH',
                    placement: [regex_placement.AI_OUTPUT], markdownOnly: true, promptOnly: false, disabled: false, minDepth: 1, maxDepth: 1, trimStrings: [] }];
                const format = id => messageFormatting('TOKEN', '', false, false, id).includes('MATCH');
                const initial = [0, 1, 2, 3, -1, 99, '1'].map(format);
                chat.push({ mes: 'New', is_system: false, extra: {} });
                const afterAppend = format(1);
                chat.at(-1).is_system = true;
                const afterRoleChange = format(1);
                chat.splice(3, 1);
                const afterDelete = format(1);
                delete chat[0];
                const missingMessage = format(0);
                delete chat[2];
                const afterHole = format(1);
                return { initial, afterAppend, afterRoleChange, afterDelete, missingMessage, afterHole };
            } finally {
                chat.splice(0, chat.length, ...originalChat);
                extension_settings.regex = originalRegex;
                extension_settings.disabledExtensions = originalDisabled;
            }
        });
        expect(result.initial).toEqual([false, true, true, false, true, true, true]);
        expect(result.afterAppend).toBe(false);
        expect(result.afterRoleChange).toBe(true);
        expect(result.afterDelete).toBe(false);
        expect(result.missingMessage).toBe(true);
        expect(result.afterHole).toBe(false);
    });

    test('formatting the newest message and transient text does not read older history', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { chat, messageFormatting } = await import('./script.js');
            const originalChat = chat.slice();
            let olderReads = 0;
            chat.length = 0;
            try {
                for (let i = 0; i < 1000; i++) {
                    const message = { mes: 'Old message', is_system: false, extra: {} };
                    Object.defineProperty(chat, i, { configurable: true, get() { olderReads++; return message; } });
                }
                chat.push({ mes: 'Newest', is_system: false, extra: {} });
                const latest = messageFormatting('**Newest**', '', false, false, 1000);
                const transient = messageFormatting('**Preview**', '', false, false, -1);
                return { olderReads, latest, transient };
            } finally {
                chat.length = 0;
                chat.push(...originalChat);
            }
        });
        expect(result.olderReads).toBe(0);
        expect(result.latest).toContain('<strong>Newest</strong>');
        expect(result.transient).toContain('<strong>Preview</strong>');
    });

    test('batches streaming scrolls while formatting every update immediately', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { StreamingDisplay } = await import('./scripts/streaming-display.js');
            const { MessageFormatter } = await import('./scripts/message-formatter.js');
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            const display = new StreamingDisplay().show();
            let hookCalls = 0;
            MessageFormatter.addHook(text => { hookCalls++; return text; });
            const reasoning = document.querySelector('.streaming-display-reasoning-content');
            const content = document.querySelector('.streaming-display-text-content');
            const getHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight').get;
            let heightReads = 0;
            for (const element of [reasoning, content]) {
                Object.defineProperty(element, 'scrollHeight', { configurable: true, get() { heightReads++; return getHeight.call(this); } });
            }
            try {
                for (let i = 0; i < 25; i++) {
                    display.updateReasoning(`Thought **${i}**\n\n` + 'Reasoning line\n\n'.repeat(50));
                    display.updateContent(`Reply **${i}**\n\n` + 'Content line\n\n'.repeat(50) + '<img src="x" onerror="alert(1)">');
                }
                const immediate = { reasoning: reasoning.textContent, content: content.textContent, heightReads, hookCalls, hasContent: display.hasContent, unsafe: Boolean(content.querySelector('[onerror]')) };
                display.complete({ delay: null });
                await frame();
                const afterFrame = {
                    heightReads,
                    reasoningAtBottom: Math.abs(reasoning.scrollTop - (getHeight.call(reasoning) - reasoning.clientHeight)) <= 1,
                    contentAtBottom: Math.abs(content.scrollTop - (getHeight.call(content) - content.clientHeight)) <= 1,
                    complete: display.isComplete,
                };
                return { immediate, afterFrame };
            } finally {
                display.hide({ instant: true });
            }
        });
        expect(result.immediate.reasoning).toContain('Thought 24');
        expect(result.immediate.content).toContain('Reply 24');
        expect(result.immediate.heightReads).toBe(0);
        expect(result.immediate.hookCalls).toBe(50);
        expect(result.immediate.hasContent).toBe(true);
        expect(result.immediate.unsafe).toBe(false);
        expect(result.afterFrame).toEqual({ heightReads: 2, reasoningAtBottom: true, contentAtBottom: true, complete: true });
    });

    test('cancels pending scroll work when a streaming panel is removed or reused', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { StreamingDisplay } = await import('./scripts/streaming-display.js');
            const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
            const display = new StreamingDisplay().show();
            const oldContent = document.querySelector('.streaming-display-text-content');
            let staleReads = 0;
            Object.defineProperty(oldContent, 'scrollHeight', { get() { staleReads++; return 100; } });
            display.updateContent('Old content').hide({ instant: true });
            await frame();
            const reset = display.hasContent;
            display.show().updateContent('**New content**').markStopped({ label: 'Stopped' });
            await frame();
            const content = document.querySelector('.streaming-display-text-content');
            const current = { staleReads, reset, text: content.textContent, bold: content.querySelector('strong')?.textContent, stopped: display.isStopped };
            display.hide({ instant: true });
            return current;
        });
        expect(result).toEqual({ staleReads: 0, reset: false, text: 'New content', bold: 'New content', stopped: true });
    });
});
