// Asking a model to make a screen, or a part of one: the request it gets and the call that sends
// it. The model is an MCP tool like any other (Apps.model()), so "make me a ticket dashboard" is a
// tool call whose answer the builder takes the HTML from.

import { FlowError } from './flow.js';

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

// The arguments of a call to the model ({ serverUrl, toolName, messageField, conversationField }):
// `prompt` in its message field, `goal` in the tool's other required text fields (Glean's chat
// wants the person's own words in _user_goal), and `conversation`, when given, in its
// conversation field. `schema` is the tool's input schema; `base` holds any other arguments.
export function modelArgs(model, { prompt, goal = prompt, conversation, schema = null, base = {} } = {}) {
    const args = { ...base };
    for (const key of schema?.required || []) {
        if (key !== model.messageField && schema.properties?.[key]?.type === 'string') args[key] = goal;
    }
    if (model.conversationField && conversation !== undefined) args[model.conversationField] = conversation;
    args[model.messageField] = prompt;
    return args;
}

// The call that asks the model for something, with an empty conversation. Throws a FlowError
// saying what to set up when there's no model yet.
export function modelCall(model, prompt, { schema = null, goal = prompt } = {}) {
    if (!model?.serverUrl || !model.toolName) {
        throw new FlowError('There is no model to ask yet. Add a server with a chat tool (Glean, or the mock), or choose one under Model.');
    }
    if (!model.messageField) throw new FlowError(`Choose the field of ${model.toolName} the request goes in, under Model.`);
    return { serverUrl: model.serverUrl, toolName: model.toolName, args: modelArgs(model, { prompt, goal, conversation: [], schema }) };
}
