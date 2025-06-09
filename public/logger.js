export function formatLog({ source, type, level, message, timestamp }) {
    return `[${source}] [${timestamp}] Message from: "${source}" - Type: "${type}" - Level: "${level}" - ${message}`;
}

export function debugLog({ source = "ServiceWorker", type = "log", level = "DEBUG", message, data = null }) {
    const timestamp = new Date().toISOString();
    let msg = message;
    if (data) {
        msg += ": " + JSON.stringify(data, null, 2);
    }
    const formatted = formatLog({ source, type, level, message: msg, timestamp });
    // Always log to console
    console.log(formatted);
    // Return log object for broadcasting
    return {
        type,
        source,
        content: {
            level,
            message: msg,
            timestamp
        }
    };
} 