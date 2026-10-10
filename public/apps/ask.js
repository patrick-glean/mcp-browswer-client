// Asking a model to make a screen, or a part of one: the request it gets and the call that sends
// it. The model is the Chat app's, an MCP tool like any other, so "make me a ticket dashboard"
// is a tool call whose answer the builder takes the HTML from.

import { FlowError } from './flow.js';

const MESSAGE_PLACEHOLDER = /\{\{(?:message|cbus_message)\}\}/g;

// What the model is asked. With `current`, it's asked to change that HTML instead of starting over.
export function askPrompt(ask, { part = false, current = '' } = {}) {
    const what = part
        ? "Write one part of an app's screen, as an HTML fragment (not a whole page)"
        : "Write the screen of an app, as one HTML page";
    return [
        `${what}: ${String(ask ?? '').trim()}`,
        current.trim() ? `Change this HTML to do that, keeping its ids:\n\n\`\`\`html\n${current.trim()}\n\`\`\`` : '',
        'Give every button, link, field and place that shows a result an id of letters, digits, - or _: the app wires them to tools by id. Put the styles in one <style> element. No scripts and nothing from the network (fonts, images, stylesheets); forms don\'t submit.',
        'Answer with the HTML alone, in one ```html block.',
    ].filter(Boolean).join('\n\n');
}

// The call that asks the model: the Chat app's model ({ serverUrl, toolName, args, messageField,
// conversationField }) with the request in its message field and an empty conversation. Throws a
// FlowError saying what to set up when the Chat app has no model yet.
export function modelCall(model, prompt) {
    if (!model?.serverUrl || !model.toolName) {
        throw new FlowError('There is no model to ask yet. In Apps, open Chat, and under Model choose the tool that answers.');
    }
    if (!model.messageField) {
        throw new FlowError(`The Chat app's model, ${model.toolName}, has no field for the message. In Chat, tick "Your message goes here" on one.`);
    }
    const args = { ...(model.args || {}) };
    const preset = args[model.messageField];
    args[model.messageField] = typeof preset === 'string' && preset.match(MESSAGE_PLACEHOLDER)
        ? preset.replace(MESSAGE_PLACEHOLDER, () => prompt)
        : prompt;
    if (model.conversationField) args[model.conversationField] = [];
    return { serverUrl: model.serverUrl, toolName: model.toolName, args };
}
