import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test('upgrades legacy browser caches and boots without JavaScript errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') console.log(message.text());
    });
    // The fresh test server's onboarding would pause application initialization.
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    await testSetup.awaitST({ page });
    await page.waitForFunction(() => localStorage.getItem('SillyTavern_PromptHistory_50_v1') === 'complete');
    await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        const prompts = localforage.createInstance({ name: 'SillyTavern_Prompts' });
        await prompts.setItem('synthetic-chat', Array.from({ length: 120 }, (_, mesId) => ({ mesId, rawPrompt: 'Test context '.repeat(1000) })));
        const thumbnails = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
        for (let i = 0; i < 160; i++) {
            await thumbnails.setItem(`synthetic-${i}`, new Blob([new Uint8Array(1024)], { type: 'image/png' }));
        }
        const tokens = localforage.createInstance({ name: 'SillyTavern_ChatCompletions' });
        const counts = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`count-${i}`, i]));
        await tokens.setItem('tokenCache', Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`chat-${i}`, counts])));
        localStorage.removeItem('SillyTavern_PromptHistory_50_v1');
    });

    await testSetup.awaitST({ page });
    await page.waitForFunction(() => localStorage.getItem('SillyTavern_PromptHistory_50_v1') === 'complete');
    const result = await page.evaluate(async () => {
        const { localforage } = await import('/lib.js');
        const { saveTokenCache } = await import('/scripts/tokenizers.js');
        await saveTokenCache();
        const prompts = await localforage.createInstance({ name: 'SillyTavern_Prompts' }).getItem('synthetic-chat');
        const thumbnails = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
        const tokens = await localforage.createInstance({ name: 'SillyTavern_ChatCompletions' }).getItem('tokenCache');
        let thumbnailBytes = 0;
        await thumbnails.iterate(blob => { thumbnailBytes += blob.size; });
        return {
            promptCount: prompts.length, firstPrompt: prompts[0].mesId,
            thumbnailCount: await thumbnails.length(), thumbnailBytes,
            tokenChats: Object.keys(tokens).length,
            largestTokenChat: Math.max(...Object.values(tokens).map(chat => Object.keys(chat).length)),
        };
    });
    expect(result.promptCount).toBe(50);
    expect(result.firstPrompt).toBe(70);
    expect(result.thumbnailCount).toBeLessThanOrEqual(128);
    expect(result.thumbnailBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.tokenChats).toBeLessThanOrEqual(16);
    expect(result.largestTokenChat).toBeLessThanOrEqual(4096);
    expect(errors).toEqual([]);
});
