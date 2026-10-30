import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/script.js', async route => {
        const response = await route.fetch();
        const body = (await response.text()).replace('await eventSource.emit(event_types.APP_READY);', 'await eventSource.emit(event_types.APP_READY); window.__messageDepthReady = true;');
        await route.fulfill({ response, body });
    });
    await page.route('**/api/settings/get', async route => {
        const response = await route.fetch();
        const body = await response.json();
        const settings = JSON.parse(body.settings);
        settings.firstRun = false;
        body.settings = JSON.stringify(settings);
        await route.fulfill({ response, json: body });
    });
    await page.goto('/');
    await page.waitForFunction(() => window.__messageDepthReady);
});

test('display depth regexes and sanitization remain correct in a long chat', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { chat, messageFormatting } = await import('/script.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const { regex_placement } = await import('/scripts/extensions/regex/engine.js');
        const originalChat = chat.slice();
        const originalRegex = extension_settings.regex;
        const originalDisabled = extension_settings.disabledExtensions;
        try {
            chat.length = 0;
            chat.push(...Array.from({ length: 5000 }, () => ({ name: 'Test', mes: 'TARGET', is_user: false, is_system: false })));
            extension_settings.disabledExtensions = originalDisabled.filter(name => name !== 'regex');
            extension_settings.regex = [{
                id: 'depth-test', scriptName: 'Depth test', findRegex: 'TARGET', replaceString: 'NEAR',
                trimStrings: [], placement: [regex_placement.AI_OUTPUT], substituteRegex: 0,
                markdownOnly: true, promptOnly: false, minDepth: 0, maxDepth: 1,
            }];
            const render = index => messageFormatting('TARGET <img src="x" onerror="alert(1)">', 'Test', false, false, index);
            const old = render(4997);
            const recent = render(4998);
            const latest = render(4999);
            chat[4998].is_system = true;
            const afterHiding = render(4997);
            return { old, recent, latest, afterHiding };
        } finally {
            chat.length = 0;
            chat.push(...originalChat);
            extension_settings.regex = originalRegex;
            extension_settings.disabledExtensions = originalDisabled;
        }
    });
    expect(result.old).toContain('TARGET');
    expect(result.recent).toContain('NEAR');
    expect(result.latest).toContain('NEAR');
    expect(result.afterHiding).toContain('NEAR');
    for (const html of Object.values(result)) expect(html).not.toContain('onerror');
});

test('unchanged reasoning keeps its DOM while formatting hooks and edits still apply', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const { chat } = await import('/script.js');
        const { ReasoningHandler, ReasoningState } = await import('/scripts/reasoning.js');
        const { power_user } = await import('/scripts/power-user.js');
        const { MessageFormatter } = await import('/scripts/message-formatter.js');
        const originalFade = power_user.stream_fade_in;
        const originalChat = chat.slice();
        const message = document.createElement('div');
        message.setAttribute('mesid', '0');
        message.innerHTML = '<button class="mes_edit_add_reasoning"></button><details class="mes_reasoning_details"><summary class="mes_reasoning_header_title"></summary><div class="mes_reasoning"></div></details>';
        const content = message.querySelector('.mes_reasoning');
        const observer = new MutationObserver(() => {});
        let hookCalls = 0;
        let suffix = '';
        let active = true;
        MessageFormatter.addHook((html, context) => {
            if (!active || !context.isReasoning) return html;
            hookCalls++;
            return html + suffix;
        });
        try {
            power_user.stream_fade_in = false;
            chat.length = 0;
            chat.push({ name: 'Test', mes: 'Answer', is_user: false, is_system: false });
            const handler = new ReasoningHandler();
            handler.messageDom = message;
            handler.state = ReasoningState.Done;
            handler.reasoning = '**Finished thought.**';
            handler.updateDom(0);
            const first = content.firstChild;
            observer.observe(content, { childList: true, subtree: true });
            for (let i = 0; i < 200; i++) handler.updateDom(0);
            const unchangedMutations = observer.takeRecords().length;
            const preservedNode = content.firstChild === first;
            const callsAfterStableFrames = hookCalls;
            suffix = '<p>Extension output</p><img src="x" onerror="alert(1)">';
            handler.updateDom(0);
            const extensionOutput = content.innerHTML;
            suffix = '';
            handler.reasoning = '**Edited thought.**';
            handler.updateDom(0);
            const editedOutput = content.textContent;
            handler.reasoning = '';
            handler.updateDom(0);
            return { unchangedMutations, preservedNode, callsAfterStableFrames, extensionOutput, editedOutput, clearedOutput: content.innerHTML };
        } finally {
            observer.disconnect();
            active = false;
            power_user.stream_fade_in = originalFade;
            chat.length = 0;
            chat.push(...originalChat);
        }
    });
    expect(result.unchangedMutations).toBe(0);
    expect(result.preservedNode).toBe(true);
    expect(result.callsAfterStableFrames).toBe(201);
    expect(result.extensionOutput).toContain('Extension output');
    expect(result.extensionOutput).not.toContain('onerror');
    expect(result.editedOutput).toContain('Edited thought.');
    expect(result.clearedOutput).toBe('');
});
