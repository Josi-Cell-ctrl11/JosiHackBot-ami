/**
 * Bus d'événements temps réel — SSE pour le dashboard Flutter
 */
const subscribers = new Set();
const recentEvents = [];
const MAX_EVENTS = 50;

function pushEvent(type, data) {
    const event = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        type,
        data,
        timestamp: new Date().toISOString(),
    };
    recentEvents.unshift(event);
    if (recentEvents.length > MAX_EVENTS) recentEvents.pop();

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
        try { res.write(payload); } catch (_) { subscribers.delete(res); }
    }
    return event;
}

function subscribe(res) {
    subscribers.add(res);
    res.write(': connected\n\n');
    for (const ev of [...recentEvents].reverse()) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
}

function unsubscribe(res) {
    subscribers.delete(res);
}

function getRecent(limit = 20) {
    return recentEvents.slice(0, limit);
}

module.exports = { pushEvent, subscribe, unsubscribe, getRecent };
