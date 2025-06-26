export type JSONValue =
  | string
  | number
  | boolean
  | JSONObject
  | null
  | JSONValue[];
export type JSONObject = { [_: string]: JSONValue };
export function flattenJson(original: JSONObject): JSONObject {
  const result: JSONValue = {};
  for (const [key, value] of Object.entries(original)) {
    const parts = key.split(".");
    let node: JSONObject = result;
    for (let i = 0; node && i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      if (node[parts[i]] == true) {
        node[parts[i]] = {};
      }
      node = node[parts[i]] as JSONObject;
    }
    if (node && parts.length) {
      node[parts[parts.length - 1]] = value;
    }
  }
  return result;
}
