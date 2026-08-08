const store = new Map();
const TTL_MS = 60 * 60 * 1000; // 1 hora

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function set(key, value) {
  store.set(key, { value, ts: Date.now() });
}

module.exports = { get, set };
