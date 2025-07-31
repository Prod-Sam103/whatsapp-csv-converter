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
    console.log(`🔄 SESSION-STORE: get called for key ${key}`);
    if (this.redis) {
      const raw = await this.redis.get(key);
      const result = raw ? JSON.parse(raw) : null;
      console.log(`🔄 SESSION-STORE: Redis get result: ${result ? (Array.isArray(result) ? result.length + ' items' : typeof result) : 'null'}`);
      return result;
    }
    const result = MEM[key] || null;
    console.log(`🔄 SESSION-STORE: Memory get result: ${result ? (Array.isArray(result) ? result.length + ' items' : typeof result) : 'null'}`);
    return result;
  }

  async del(key) {
    if (this.redis) return this.redis.del(key);
    delete MEM[key];
  }

  /* ------------- contact staging ------------- */
  async appendContacts(phone, list) {
    console.log(`🔄 SESSION-STORE: appendContacts called for ${phone} with ${list.length} contacts`);
    const key = `contacts:${phone}`;
    console.log(`🔄 SESSION-STORE: Using key ${key}`);
    
    const current = (await this.get(key)) || [];
    console.log(`🔄 SESSION-STORE: Found ${current.length} existing contacts`);
    
    const merged  = current.concat(list);
    console.log(`🔄 SESSION-STORE: Merged total: ${merged.length} contacts`);
    
    await this.set(key, merged, 7200);   // 2 h stash
    console.log(`🔄 SESSION-STORE: Saved ${merged.length} contacts to storage`);
    
    return merged.length;
  }

  async popContacts(phone) {
    console.log(`🔄 SESSION-STORE: popContacts called for ${phone}`);
    const key = `contacts:${phone}`;
    console.log(`🔄 SESSION-STORE: Using key ${key}`);
    
    const data = (await this.get(key)) || [];
    console.log(`🔄 SESSION-STORE: Retrieved ${data.length} contacts`);
    
    await this.del(key);
    console.log(`🔄 SESSION-STORE: Deleted contacts from storage`);
    
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
