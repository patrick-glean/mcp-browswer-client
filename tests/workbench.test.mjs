// Opening a run from history (public/workbench/workbench.js): a Workbench run comes back as it was
// written, and a call an app made as it was sent, since its {{names}} are the app's screen's.
//
//   node --test tests/workbench.test.mjs    (npm run test:unit)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openedRun } from '../public/workbench/workbench.js';

const startedAt = Date.now();

test('a Workbench run opens with its arguments as written, {{variables}} and all', () => {
    assert.deepEqual(openedRun({ source: 'workbench', startedAt, args: { text: '{{greeting}} world' }, sentArgs: { text: 'hi world' } }),
        { args: { text: '{{greeting}} world' }, text: 'Opened the Workbench run from just now.' });
    assert.deepEqual(openedRun({ source: 'collection', startedAt, args: null, argsText: '{"text": "…', sentArgs: null }),
        { args: {}, text: 'The arguments were too big to keep, so the fields are empty.' });
});

test("a call an app made opens with what it sent, and says which of the app's names it filled in", () => {
    const run = {
        source: 'app', startedAt,
        args: { message: '{{message}}', history: '{{conversation}}' },
        sentArgs: { message: "You're the assistant…\n\nhello", history: ['User: hi', 'Assistant: Hello.'] },
    };
    assert.deepEqual(openedRun(run), {
        args: run.sentArgs,
        text: "Opened the app's call, with what it sent: the app filled in {{message}} and {{conversation}}. Run sends it again.",
    });
    assert.equal(openedRun({ ...run, args: { message: 'a calculator' }, sentArgs: { message: 'a calculator' } }).text,
        "Opened the app's call, with what it sent. Run sends it again.");
    assert.deepEqual(openedRun({ source: 'reply', startedAt, args: { text: 'hello' }, sentArgs: { text: 'hello' } }),
        { args: { text: 'hello' }, text: "Opened the call a model's reply asked for, with what it sent. Run sends it again." });
    assert.deepEqual(openedRun({ ...run, sentArgs: null, sentArgsText: '{"message": "…' }),
        { args: {}, text: "What the app's call sent was too big to keep in full, so the fields are empty. Sent, in the response, shows its start." });
});
