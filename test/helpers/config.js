// Single place where tests inject configuration. v1 reads settings from process.env;
// when v2 moves to an in-memory config store, only this file changes.
export function applyConfig(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
