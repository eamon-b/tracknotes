// Vite's `?raw` import: a file's text (test/probes.test.ts reads the probe
// script). In a file of its own: a wildcard module declaration must not sit in
// a module (env.d.ts imports, so it is one).
declare module '*?raw' {
  const text: string;
  export default text;
}
