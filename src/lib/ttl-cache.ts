const store = new Map<string, { expires: number; value: Promise<unknown> }>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

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
