import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';

// A real DOM with only the observer modules loaded. Unrelated UI modules are
// stubbed so these checks don't need credentials, chat data or an app server.
async function observerHarness(page, language = 'en', translations = {}) {
    await page.route('http://observer.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/') {
            return route.fulfill({ contentType: 'text/html', body: '<html><body><select id="ui_language_select"></select><script src="/jquery.js"></script></body></html>' });
        }
        if (path === '/locales/lang.json') return route.fulfill({ json: language === 'en' ? [] : [{ lang: language, display: language }] });
        if (path === `/locales/${language}.json`) return route.fulfill({ json: translations });
        if (path === '/scripts/power-user.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const registerDebugFunction = () => {};' });
        if (path === '/scripts/secrets.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const updateSecretDisplay = () => {};' });
        const files = {
            '/jquery.js': '../../public/lib/jquery-3.5.1.min.js',
            '/scripts/i18n.js': '../../public/scripts/i18n.js',
            '/scripts/a11y.js': '../../public/scripts/a11y.js',
        };
        if (files[path]) return route.fulfill({ contentType: 'text/javascript', body: await fs.readFile(new URL(files[path], import.meta.url), 'utf8') });
        return route.fulfill({ status: 404 });
    });
    await page.goto('http://observer.test/');
    await page.evaluate(value => localStorage.setItem('language', value), language);
}

test('English DOM updates skip locale scans but extension translations still activate', async ({ page }) => {
    await observerHarness(page);
    const result = await page.evaluate(async () => {
        const { initLocales, addLocaleData, applyLocale } = await import('/scripts/i18n.js');
        await initLocales();
        let scans = 0;
        const originalQuery = Element.prototype.querySelectorAll;
        Element.prototype.querySelectorAll = function (selector) {
            if (selector === '[data-i18n]') scans++;
            return originalQuery.call(this, selector);
        };
        try {
            for (let i = 0; i < 100; i++) {
                const message = document.createElement('div');
                message.innerHTML = '<p>Chat text <span>with nested markup</span></p><button data-i18n="Greeting">Hello</button>';
                document.body.append(message);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
            const englishScans = scans;
            const untouchedTemplate = applyLocale('<p data-i18n="Greeting">Hello</p>');
            addLocaleData('en', { Greeting: 'Extension greeting' });
            const dynamic = document.createElement('button');
            dynamic.setAttribute('data-i18n', 'Greeting');
            document.body.append(dynamic);
            await new Promise(resolve => setTimeout(resolve, 0));
            const translatedText = dynamic.textContent;
            dynamic.setAttribute('data-i18n', '[title]Greeting');
            await new Promise(resolve => setTimeout(resolve, 0));
            return { englishScans, untouchedTemplate, translatedText, title: dynamic.title, translatedTemplate: applyLocale('<p data-i18n="Greeting">Hello</p>') };
        } finally {
            Element.prototype.querySelectorAll = originalQuery;
        }
    });
    expect(result.englishScans).toBe(0);
    expect(result.untouchedTemplate).toBe('<p data-i18n="Greeting">Hello</p>');
    expect(result.translatedText).toBe('Extension greeting');
    expect(result.title).toBe('Extension greeting');
    expect(result.translatedTemplate).toBe('<p data-i18n="Greeting">Extension greeting</p>');
});

test('accessibility preserves all role groups and precedence', async ({ page }) => {
    await observerHarness(page);
    const result = await page.evaluate(async () => {
        const { initAccessibility } = await import('/scripts/a11y.js');
        initAccessibility();
        const wrapper = document.createElement('div');
        wrapper.innerHTML = '<div class="menu_button" id="button"></div><div class="list-group" id="list"><div class="list-group-item menu_button" id="item"></div></div><div class="jg-menu" id="toolbar"></div><div id="bg_tabs"><div class="bg_tabs_list" id="tablist"><div class="bg_tab_button" id="tab"></div></div></div><div id="toast-container"><div class="toast" id="toast"></div></div>';
        document.body.append(wrapper);
        await new Promise(resolve => setTimeout(resolve, 0));
        return { roles: Object.fromEntries(['button', 'list', 'item', 'toolbar', 'tablist', 'tab', 'toast'].map(id => [id, document.getElementById(id).getAttribute('role')])) };
    });
    expect(result.roles).toEqual({ button: 'button', list: 'list', item: 'listitem', toolbar: 'toolbar', tablist: 'tablist', tab: 'tab', toast: 'status' });
});

test('non-English dictionaries still translate existing and dynamically inserted content', async ({ page }) => {
    await observerHarness(page, 'fr-fr', { Greeting: 'Bonjour', Empty: '' });
    const result = await page.evaluate(async () => {
        const existing = document.createElement('span');
        existing.setAttribute('data-i18n', 'Greeting');
        document.body.append(existing);
        const { initLocales } = await import('/scripts/i18n.js');
        await initLocales();
        const dynamic = document.createElement('div');
        dynamic.innerHTML = '<span data-i18n="Greeting">Hello</span><button data-i18n="[title]Greeting;Empty">Remove this</button>';
        document.body.append(dynamic);
        await new Promise(resolve => setTimeout(resolve, 0));
        return { existing: existing.textContent, child: dynamic.firstChild.textContent, empty: dynamic.lastChild.textContent, title: dynamic.lastChild.title };
    });
    expect(result).toEqual({ existing: 'Bonjour', child: 'Bonjour', empty: '', title: 'Bonjour' });
});
