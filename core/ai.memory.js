'use strict';
// core/ai.memory.js — Enhanced conversation memory with preferences and learning

const { connection: redis } = require('../services/redis');
const logger  = require('./logger');
const NODE_ID = require('../utils/nodeId');
const { safeJsonParse } = require('../utils/validator');

async function getMemory(userId) {
    try {
        const key  = `ai_memory:${NODE_ID}:${userId}`;
        const data = await redis.lrange(key, 0, 29); // increased to 30 exchanges
        return data
            .map((str) => safeJsonParse(str))
            .filter(Boolean)
            .reverse();
    } catch (err) {
        logger.warn('[AI Memory] getMemory failed', { error: err.message });
        return [];
    }
}

async function updateMemory(userId, userText, aiText) {
    try {
        const key   = `ai_memory:${NODE_ID}:${userId}`;
        const entry = JSON.stringify({ user: userText, ai: aiText, timestamp: Date.now() });
        await redis.lpush(key, entry);
        await redis.ltrim(key, 0, 29);  // keep last 30 exchanges
        await redis.expire(key, 172800); // 48 hours
    } catch (err) {
        logger.warn('[AI Memory] updateMemory failed', { error: err.message });
    }
}

async function getUserPreferences(userId) {
    try {
        const key = `ai_prefs:${NODE_ID}:${userId}`;
        const data = await redis.get(key);
        return data ? safeJsonParse(data) : {};
    } catch (err) {
        logger.warn('[AI Memory] getUserPreferences failed', { error: err.message });
        return {};
    }
}

async function updateUserPreference(userId, prefKey, prefValue) {
    try {
        const key = `ai_prefs:${NODE_ID}:${userId}`;
        const prefs = await getUserPreferences(userId);
        prefs[prefKey] = prefValue;
        prefs.lastUpdated = Date.now();
        await redis.set(key, JSON.stringify(prefs));
        await redis.expire(key, 2592000); // 30 days
        return prefs;
    } catch (err) {
        logger.warn('[AI Memory] updateUserPreference failed', { error: err.message });
        return {};
    }
}

async function getUserContext(userId) {
    try {
        const memory = await getMemory(userId);
        const prefs = await getUserPreferences(userId);
        
        const contextLines = [];
        if (prefs.name) contextLines.push(`User's name: ${prefs.name}`);
        if (prefs.language) contextLines.push(`Preferred language: ${prefs.language}`);
        if (prefs.tone) contextLines.push(`Communication style: ${prefs.tone}`);
        if (prefs.interests) contextLines.push(`Interests: ${prefs.interests}`);
        
        const recentTopics = memory.slice(0, 5).map(m => m.user).join(', ');
        if (recentTopics) contextLines.push(`Recent topics: ${recentTopics}`);
        
        return contextLines.join('. ');
    } catch (err) {
        return '';
    }
}

module.exports = { getMemory, updateMemory, getUserPreferences, updateUserPreference, getUserContext };
