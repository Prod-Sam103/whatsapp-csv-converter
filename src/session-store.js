/**
 * Session & temp-file storage
 * • Redis (preferred) with 15 s socket timeout
 * • Falls back to in-memory if REDIS_URL is missing
 */

const redis = require('redis');

const MEM = {};              // in-process fallback
const TTL_DEFAULT = 3600;    // 1 h

class Store {
  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      this.redis = redis.createClient({
        url,
        socket: { connectTimeout: 15000 }   // 15 000 ms instead of 5 000
      });
      this.redis.on('error', (error) => {
        if (process.env.NODE_ENV !== 'production') {
          console.error('Redis error:', error);
        } else {
          console.error('Redis connection error occurred');
        }
      });
      this.redis.connect();
    }
  }

  /* ------------- generic KV helpers ------------- */
  async set(key, val, ttl = TTL_DEFAULT) {
    if (this.redis) {
      return this.redis.set(key, JSON.stringify(val), { EX: ttl });
    }
    MEM[key] = val;
    setTimeout(() => delete MEM[key], ttl * 1000);
  }

  async get(key) {
    if (this.redis) {
      const raw = await this.redis.get(key);
      return raw ? JSON.parse(raw) : null;
    }
    return MEM[key] || null;
  }

  async del(key) {
    if (this.redis) return this.redis.del(key);
    delete MEM[key];
  }

  /* ------------- contact staging ------------- */
  async appendContacts(phone, list) {
    const key = `contacts:${phone}`;
    const current = (await this.get(key)) || [];
    const merged  = current.concat(list);
    await this.set(key, merged, 7200);   // 2 h stash
    return merged.length;
  }

  async popContacts(phone) {
    const key = `contacts:${phone}`;
    const data = (await this.get(key)) || [];
    await this.del(key);
    return data;
  }

  /* ------------- duplicate-resolver state ------------- */
  async setDupState(phone, state, ttlSec = 120) {
    return this.set(`dup:${phone}`, state, ttlSec);
  }
  async getDupState(phone)  { return this.get(`dup:${phone}`); }
  async clearDupState(phone){ return this.del(`dup:${phone}`); }

  /* ------------- temp CSV files ------------- */
  async setTempFile(id, obj, ttlSec) { return this.set(`file:${id}`, obj, ttlSec); }
  async getTempFile(id)              { return this.get(`file:${id}`); }
}

module.exports = new Store();
