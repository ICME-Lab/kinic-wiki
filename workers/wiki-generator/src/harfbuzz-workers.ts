// Where: workers/wiki-generator/src/harfbuzz-workers.ts
// What: Replaces the `harfbuzzjs` entry that satori imports (see harfbuzz-workers-plugin.ts).
// Why: The package entry reads hb.wasm from disk and compiles a Wasm thunk for each JS callback, and workerd allows neither. Here hb.wasm comes from a static import and no thunk is needed.
import createHarfBuzz from "harfbuzzjs/hb.js";
import hbjs from "harfbuzzjs/hbjs.js";
import hbWasm from "harfbuzzjs/hb.wasm";

export default createHarfBuzz({
  instantiateWasm(imports, receiveInstance) {
    const module = hbWasm as WebAssembly.Module;
    void WebAssembly.instantiate(module, imports).then((instance) => receiveInstance(instance, module));
    return {};
  }
}).then((harfBuzz) => {
  // hbjs registers one callback at init, a JS wrapper around the Wasm `free`. Registering
  // that export directly needs no thunk. Satori uses no other hbjs callback, so the rest
  // keep the default path, which throws in workerd.
  const addFunction = harfBuzz.addFunction;
  harfBuzz.addFunction = (callback, signature) => addFunction(signature === "vi" ? harfBuzz.wasmExports.free : callback, signature);
  return hbjs(harfBuzz);
});
