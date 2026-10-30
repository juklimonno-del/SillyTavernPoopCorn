/**
 * Reads an API error without mistaking a successful message_start event for one.
 * Invalid JSON and ordinary completion chunks are not errors.
 * @param {string} decoded Response text or a single SSE data field
 * @returns {object|null} Parsed error response, if present
 */
export function parseChatCompletionError(decoded) {
    let data;
    try {
        data = JSON.parse(decoded);
    } catch {
        return null;
    }

    if (data?.error || data?.quota_error || data?.detail || typeof data?.message === 'string') {
        return data;
    }

    return null;
}
