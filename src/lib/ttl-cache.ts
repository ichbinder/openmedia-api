const MAX_ENTRIES = 5000;
const store = new Map<string, { expires: number; value: Promise<unknown> }>();

function makeRoom(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [k, e] of store) if (e.expires <= now) store.delete(k);
  while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value!);
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

  store.delete(key);
  makeRoom(Date.now());
  const value = load();
  const entry = { expires: Date.now() + ttlMs, value };
  store.set(key, entry);
  const drop = () => {
    if (store.get(key) === entry) store.delete(key);
  };
  value.then((v) => keep(v) || drop(), drop);
  return value;
}

export function clearCache(): void {
  store.clear();
}
