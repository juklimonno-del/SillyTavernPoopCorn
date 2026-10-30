/**
 * Count later non-system messages for depth-sensitive display regexes. Most
 * formatting targets the recent tail or the currently streaming last message;
 * do not allocate/filter a copy of the entire chat for each rendered fragment.
 * @param {Array<{is_system?: boolean}>} messages Chat messages
 * @param {number|string} messageId Message index (or -1 for transient output)
 * @returns {number|undefined} Depth, excluding system messages
 */
export function getMessageDepth(messages, messageId) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0 || index >= messages.length || !messages[index] || messages[index].is_system) {
        return undefined;
    }
    let depth = 0;
    for (let i = index + 1; i < messages.length; i++) {
        if (i in messages && !messages[i].is_system) depth++;
    }
    return depth;
}
