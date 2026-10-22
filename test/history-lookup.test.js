'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hydrateChatHistory, findHistoryMessage } = require('../api');

test('un message de l\'historique se retrouve par id, dans sa discussion ou ailleurs', () => {
    hydrateChatHistory({
        'a@s.whatsapp.net': [{ id: 'X1', text: 'salut', name: 'Ana' }],
        'b@lid': [{ id: 'X2', text: 'yo', name: 'Bob' }],
    });
    assert.deepEqual(findHistoryMessage('a@s.whatsapp.net', 'X1'), { chatId: 'a@s.whatsapp.net', text: 'salut', name: 'Ana' });
    assert.equal(findHistoryMessage('a@s.whatsapp.net', 'X2').chatId, 'b@lid');
    assert.equal(findHistoryMessage(null, 'absent'), null);
});
