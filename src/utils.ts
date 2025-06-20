export function flattenJson(original: object): object {
  const result = {};
  for (const [key, value] of Object.entries(original)) {
    const parts = key.split(".");
    let node = result;
    for (let i = 0; node && i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    if (node && parts.length) {
      node[parts[parts.length - 1]] = value;
    }
  }
  return result;
}
