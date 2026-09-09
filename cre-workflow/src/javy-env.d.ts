// What the workflow runtime actually provides.
//
// The `lib` in tsconfig.json is ES2022 with no DOM and no @types/node, on
// purpose: CRE workflows compile to WASM and run under Javy (QuickJS), so
// `fetch`, `setTimeout`, `window`, `Buffer` and every node: builtin are
// absent. Leaving them out of the type environment turns "that API does not
// exist here" from a runtime surprise into a compile error.
//
// Declared below is only what Javy does supply and this workflow needs. The
// SDK itself encodes protobuf and JSON through these two.

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array): string;
}
