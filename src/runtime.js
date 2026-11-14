// Shared handle between the host-plane plugin (src/host.js) and the
// preset-scoped tool plugin (src/tools.js). Both modules load from the same
// package, so they share this module instance. The host sets `current` while it
// is running; the tools read it at call time.
export const runtime = { current: undefined };

export function requireRuntime() {
  const value = runtime.current;
  if (value === undefined) throw new Error('The dsh-super-leader host plugin is not running. Enable the "super-leader" entry in this profile.');
  return value;
}
