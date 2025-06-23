export type JSON_VALUE =
  | string
  | number
  | boolean
  | JSON_OBJECT
  | null
  | JSON_VALUE[];
export type JSON_OBJECT = { [_: string]: JSON_VALUE };
export function flattenJson(original: JSON_OBJECT): JSON_OBJECT {
  const result: JSON_VALUE = {};
  for (const [key, value] of Object.entries(original)) {
    const parts = key.split(".");
    let node: JSON_OBJECT = result;
    for (let i = 0; node && i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      if (node[parts[i]] == true) {
        node[parts[i]] = {};
      }
      node = node[parts[i]] as JSON_OBJECT;
    }
    if (node && parts.length) {
      node[parts[parts.length - 1]] = value;
    }
  }
  return result;
}
