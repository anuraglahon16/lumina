#!/usr/bin/env node
import { config } from '../src/shared/config.js';
import { signToken } from '../src/shared/token.js';
import { newId } from '../src/shared/ids.js';

/**
 * Mint a signed identity token for an API client.
 *
 * Browsers get one automatically on first visit; scripts and services need one
 * issued out of band, which is what this is for.
 *
 *   node scripts/mint-token.js [user-id] [--ttl-days N]
 */

const args = process.argv.slice(2);
const ttlFlag = args.indexOf('--ttl-days');
const ttlDays = ttlFlag === -1 ? null : Number(args[ttlFlag + 1]);
const userId = args.find((a) => !a.startsWith('--') && a !== String(ttlDays)) || newId('usr');

if (!config.gateway.authSecret) {
  console.error('AUTH_SECRET is not set, so tokens cannot be signed and the gateway would ignore one.');
  console.error('Set it in .env first:  AUTH_SECRET=$(openssl rand -base64 32)');
  process.exit(1);
}

const ttlSeconds = ttlDays ? Math.round(ttlDays * 24 * 60 * 60) : config.gateway.authTtlSeconds;
const token = signToken({ sub: userId }, config.gateway.authSecret, ttlSeconds);

console.log(`user id : ${userId}`);
console.log(`expires : ${ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : 'never'}`);
console.log(`\n${token}\n`);
console.log('Use it as:');
console.log(`  curl -H "Authorization: Bearer ${token.slice(0, 24)}..." http://localhost:8080/api/threads`);
