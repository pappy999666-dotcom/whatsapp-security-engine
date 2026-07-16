'use strict';

const crypto = require('crypto');
const { sql } = require('drizzle-orm');

// Canonical parameterized form: SELECT * FROM web_accounts WHERE user_id=$1 ORDER BY created_at DESC
let pool;
let db;
function database() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const { Pool } = require('pg');
    const { drizzle } = require('drizzle-orm/node-postgres');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
    db = drizzle(pool);
  }
  return db;
}
function rows(result) { return result?.rows || result || []; }
function id(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`; }
async function execute(query) { const client = database(); if (!client) throw new Error('DATABASE_URL is not configured'); return client.execute(query); }

async function upsertGithubUser(profile) {
  const githubId = String(profile.id);
  const existing = rows(await execute(sql`SELECT * FROM web_users WHERE github_id=${githubId} LIMIT 1`))[0];
  const userId = existing?.id || id('web');
  const ownerId = existing?.global_owner_id || id('owner');
  await execute(sql`INSERT INTO global_owners (id, primary_platform) VALUES (${ownerId}, 'web') ON CONFLICT (id) DO UPDATE SET updated_at=now()`);
  await execute(sql`INSERT INTO web_users (id, github_id, github_username, avatar_url, email, global_owner_id) VALUES (${userId}, ${githubId}, ${profile.login}, ${profile.avatar_url || ''}, ${profile.email || null}, ${ownerId}) ON CONFLICT (github_id) DO UPDATE SET github_username=EXCLUDED.github_username, avatar_url=EXCLUDED.avatar_url, email=EXCLUDED.email, last_seen_at=now()`);
  await execute(sql`INSERT INTO web_settings (user_id, global_owner_id) VALUES (${userId}, ${ownerId}) ON CONFLICT (user_id) DO NOTHING`);
  return rows(await execute(sql`SELECT * FROM web_users WHERE id=${userId} LIMIT 1`))[0];
}
async function getUser(userId) { return rows(await execute(sql`SELECT * FROM web_users WHERE id=${userId} LIMIT 1`))[0] || null; }
async function dashboard(user) {
  const accounts = rows(await execute(sql`SELECT * FROM web_accounts WHERE user_id=${user.id} ORDER BY created_at DESC`));
  const activity = rows(await execute(sql`SELECT * FROM web_activity WHERE user_id=${user.id} ORDER BY created_at DESC LIMIT 80`));
  const links = rows(await execute(sql`SELECT * FROM web_links WHERE user_id=${user.id} ORDER BY created_at DESC LIMIT 100`));
  const scans = rows(await execute(sql`SELECT * FROM web_radar_scans WHERE user_id=${user.id} ORDER BY created_at DESC LIMIT 30`));
  const settings = rows(await execute(sql`SELECT * FROM web_settings WHERE user_id=${user.id} LIMIT 1`))[0] || {};
  const commands = Number(rows(await execute(sql`SELECT COUNT(*)::int AS count FROM web_command_runs WHERE user_id=${user.id}`))[0]?.count || 0);
  return { user, accounts, activity, links, scans, settings, stats: { accounts: accounts.length, active: accounts.filter(a => a.status === 'connected').length, commands, links: links.length, scans: scans.length } };
}
async function createAccount(user, phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (clean.length < 8 || clean.length > 15) throw new Error('Enter a valid international phone number');
  const accountId = id('wa'); const sessionKey = `${user.id}_${clean}_1`;
  await execute(sql`INSERT INTO web_accounts (id,user_id,global_owner_id,phone_number,session_key,status) VALUES (${accountId},${user.id},${user.global_owner_id},${clean},${sessionKey},'pairing') ON CONFLICT (user_id,phone_number) DO UPDATE SET status='pairing', session_key=EXCLUDED.session_key`);
  return rows(await execute(sql`SELECT * FROM web_accounts WHERE user_id=${user.id} AND phone_number=${clean} LIMIT 1`))[0];
}
async function updateAccount(userId, accountId, status) { await execute(sql`UPDATE web_accounts SET status=${status}, last_active_at=now() WHERE id=${accountId} AND user_id=${userId}`); }
async function log(user, type, message, level='info', accountId=null) { await execute(sql`INSERT INTO web_activity (user_id,global_owner_id,account_id,type,message,level) VALUES (${user.id},${user.global_owner_id},${accountId},${type},${message},${level})`); }
async function addLinks(user, input, source='manual') {
  const links = [...new Set(String(input || '').match(/https?:\/\/[^\s]+/g) || [])].slice(0,100);
  for (const url of links) await execute(sql`INSERT INTO web_links (user_id,global_owner_id,url,source) VALUES (${user.id},${user.global_owner_id},${url},${source}) ON CONFLICT (user_id,url) DO NOTHING`);
  await log(user,'links',`${links.length} links synchronized to Global Owner DB`); return links;
}
async function addScan(user,target) { const scanId=id('scan'); await execute(sql`INSERT INTO web_radar_scans (id,user_id,global_owner_id,target_url,status,result,completed_at) VALUES (${scanId},${user.id},${user.global_owner_id},${target},'completed',${JSON.stringify({valid:/chat\.whatsapp\.com|whatsapp\.com\/channel/.test(target),source:'web'})}::jsonb,now())`); await log(user,'radar','Radar scan completed'); return scanId; }
async function saveCommand(user, accountId, command, response) { await execute(sql`INSERT INTO web_command_runs (user_id,global_owner_id,account_id,command,response) VALUES (${user.id},${user.global_owner_id},${accountId || null},${command},${response})`); await log(user,'commands',`Command executed: ${command.slice(0,80)}`); }
async function saveSettings(user, data) { await execute(sql`UPDATE web_settings SET auto_reconnect=${Boolean(data.autoReconnect)}, notifications_enabled=${Boolean(data.notifications)}, command_prefix=${String(data.prefix || '.').slice(0,3)}, privacy_mode=${Boolean(data.privacy)}, updated_at=now() WHERE user_id=${user.id}`); await log(user,'settings','Settings synchronized'); }
module.exports={ database,getUser,upsertGithubUser,dashboard,createAccount,updateAccount,log,addLinks,addScan,saveCommand,saveSettings };
