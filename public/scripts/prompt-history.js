// Prompt inspection is diagnostic history, separate from saved chat messages.
export const PROMPT_HISTORY_LIMIT = 50;

export function recentPrompts(prompts) {
    return Array.isArray(prompts) ? prompts.slice(-PROMPT_HISTORY_LIMIT) : [];
}

/**
 * Serializes access to diagnostic snapshots so background pruning cannot
 * overwrite a new save or resurrect a deleted chat's prompt history.
 */
export class PromptHistoryStore {
    constructor(storage) {
        this.storage = storage;
        this.pending = Promise.resolve();
        this.queuedSave = null;
    }

    run(operation) {
        // Reads/deletes are ordering barriers: never merge a later save across them.
        this.queuedSave = null;
        const result = this.pending.then(() => {
            // Coordinate migration with saves in other updated tabs, where supported.
            const locks = globalThis.navigator?.locks;
            return locks ? locks.request('SillyTavern_PromptHistory', operation) : operation();
        });
        // The queue tail must not retain the last loaded history in memory.
        this.pending = result.then(() => {}, () => {});
        return result;
    }

    load(chatId, strictPrune = false) {
        return this.run(async () => {
            const stored = await this.storage.getItem(chatId);
            const recent = recentPrompts(stored);
            if (Array.isArray(stored) && stored.length > PROMPT_HISTORY_LIMIT) {
                try {
                    await this.storage.setItem(chatId, recent);
                } catch (error) {
                    if (strictPrune) throw error;
                    // A full store must not hide snapshots that were read successfully.
                    console.warn('Unable to trim stored prompt snapshots', error);
                }
            }
            return recent;
        });
    }

    save(chatId, prompts) {
        // Capture this chat's array before waiting for other storage operations.
        const recent = recentPrompts(prompts);
        if (this.queuedSave?.chatId === chatId) {
            this.queuedSave.prompts = recent;
            return this.queuedSave.promise;
        }
        const entry = { chatId, prompts: recent, promise: null };
        entry.promise = this.run(() => {
            if (this.queuedSave === entry) this.queuedSave = null;
            return this.storage.setItem(chatId, entry.prompts);
        });
        this.queuedSave = entry;
        return entry.promise;
    }

    remove(chatId) {
        return this.run(() => this.storage.removeItem(chatId));
    }

    clear() {
        return this.run(() => this.storage.clear());
    }

    async pruneAll() {
        const keys = await this.run(() => this.storage.keys());
        for (const key of keys) {
            await this.load(key, true);
            // Give rendering and new saves a turn between old chat histories.
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
}
