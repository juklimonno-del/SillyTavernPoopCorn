// Only derived token counts live here. Evicted values can be calculated again;
// chat messages, prompts and settings are never part of this cache.
class TokenCounts extends Map {
    constructor(limit, onChange) {
        super();
        this.limit = limit;
        this.onChange = onChange;
    }

    get(key) {
        const value = super.get(key);
        if (super.has(key)) {
            super.delete(key);
            super.set(key, value);
        }
        return value;
    }

    set(key, value) {
        if (!Number.isFinite(value)) {
            return this;
        }
        super.delete(key);
        super.set(key, value);
        if (this.size > this.limit) {
            super.delete(this.keys().next().value);
        }
        this.onChange();
        return this;
    }
}

/** Bounded, least-recently-used cache with the existing IndexedDB JSON format. */
export class TokenCountCache {
    constructor(maxChats = 16, maxCountsPerChat = 4096) {
        this.maxChats = maxChats;
        this.maxCountsPerChat = maxCountsPerChat;
        this.chats = new Map();
        this.version = 0;
    }

    getChat(chatId) {
        const key = String(chatId);
        let counts = this.chats.get(key);
        if (!counts) {
            counts = new TokenCounts(this.maxCountsPerChat, () => this.version++);
            this.version++;
        }
        this.chats.delete(key);
        this.chats.set(key, counts);
        if (this.chats.size > this.maxChats) {
            this.chats.delete(this.chats.keys().next().value);
        }
        return counts;
    }

    clear() {
        this.chats.clear();
        this.version++;
    }

    load(data) {
        this.clear();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return;
        }
        for (const chatId of Object.keys(data).slice(-this.maxChats)) {
            const values = data[chatId];
            if (!values || typeof values !== 'object' || Array.isArray(values)) {
                continue;
            }
            const counts = this.getChat(chatId);
            for (const key of Object.keys(values).slice(-this.maxCountsPerChat)) {
                counts.set(key, values[key]);
            }
        }
    }

    toJSON() {
        return Object.fromEntries(Array.from(this.chats, ([chatId, counts]) => [chatId, Object.fromEntries(counts)]));
    }
}
