/**
 * Redis-backed session store with in-memory fallback
 */
const redis = require('redis');

const MEM = {};
const TTL_DEFAULT = 3600;   // 1 h

class Store {
  constructor() {
    if (process.env.REDIS_URL) {
      this.redis = redis.createClient({ url: process.env.REDIS_URL });
      this.redis.on('error', console.error);
      this.redis.connect();
    }
  }

  async set(key, val, ttl = TTL_DEFAULT) {
    if (this.redis) return this.redis.set(key, JSON.stringify(val), { EX: ttl });
    MEM[key] = val; setTimeout(() => delete MEM[key], ttl * 1000);
  }
  async get(key) {
    if (this.redis) {
      const v = await this.redis.get(key);
      return v ? JSON.parse(v) : null;
    }
    return MEM[key] || null;
  }
  async del(key) {
    if (this.redis) return this.redis.del(key);
    delete MEM[key];
  }

  /* contact staging */
  async appendContacts(phone, list) {
    const key = `contacts:${phone}`;
    const cur = (await this.get(key)) || [];
    const merged = cur.concat(list);
    await this.set(key, merged, 7200);
    return merged.length;
  }
  async popContacts(phone) {
    const key = `contacts:${phone}`;
    const data = await this.get(key) || [];
    await this.del(key);
    return data;
  }

  /* duplicate-resolver */
  async setDupState(phone, state, ttl = 120) {
    return this.set(`dup:${phone}`, state, ttl);
  }
  async getDupState(phone) { return this.get(`dup:${phone}`); }
  async clearDupState(phone) { return this.del(`dup:${phone}`); }

  /* temp files */
  async setTempFile(id, obj, ttl) { return this.set(`file:${id}`, obj, ttl); }
  async getTempFile(id) { return this.get(`file:${id}`); }
}

module.exports = new Store();
