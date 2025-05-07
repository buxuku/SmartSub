let store: Record<string, string> = {};

const setStoreItem = (key: string, value: string) => {
  store = { ...store, [key]: value };
};

function getItem<T = object>(key: string, initialValue = ''): T | string {
  if (!store[key]) {
    setStoreItem(key, localStorage?.getItem(key) || '');
  }
  try {
    return store[key] ? JSON.parse(store[key]) : initialValue;
  } catch {
    return store[key] || initialValue;
  }
}
/**
 * 删除
 */
const removeItem = (key: string) => {
  if (store[key]) {
    delete store[key];
  }
  localStorage?.removeItem(key);
};

function setItem<T>(key: string, value: T) {
  const result: string = (
    typeof value === 'object' ? JSON.stringify(value) : value
  ) as string;
  setStoreItem(key, result);
  localStorage?.setItem(key, result);
}

export default {
  getItem,
  setItem,
  removeItem,
};
