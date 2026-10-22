'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contacts = require('../contacts');

test('un groupe n\'a pas de numéro : pas de faux @s.whatsapp.net', () => {
    assert.equal(contacts.resolvePn('120363432365860398@g.us'), null);
    assert.equal(contacts.resolvePn('status@broadcast'), null);
    assert.equal(contacts.resolvePn('120363000000000000@newsletter'), null);
});

test('un numéro normal se résout toujours', () => {
    assert.equal(contacts.resolvePn('33612345678@s.whatsapp.net'), '33612345678@s.whatsapp.net');
    assert.equal(contacts.resolvePn('33612345678:12@s.whatsapp.net'), '33612345678@s.whatsapp.net');
});

test('l\'envoi vers un groupe ne propose plus de faux numéro', () => {
    assert.deepEqual(contacts.jidCandidates('120363432365860398@g.us'), ['120363432365860398@g.us']);
});

test('les anciens faux fils de groupe sont reconnus', () => {
    assert.equal(contacts.isBogusPnChat('120363432365860398@s.whatsapp.net'), true);
    assert.equal(contacts.isBogusPnChat('33612345678@s.whatsapp.net'), false);
    assert.equal(contacts.isBogusPnChat('120363432365860398@g.us'), false);
});
