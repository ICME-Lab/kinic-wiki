declare module "*.wasm" {
  const mod: unknown;
  export default mod;
}

declare module "harfbuzzjs/hb.js" {
  export type HarfBuzzModule = {
    wasmExports: { free: Function };
    addFunction: (callback: Function, signature: string) => number;
  };
  const createHarfBuzz: (options: {
    instantiateWasm: (imports: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => object;
  }) => Promise<HarfBuzzModule>;
  export default createHarfBuzz;
}

declare module "harfbuzzjs/hbjs.js" {
  const hbjs: (harfBuzz: import("harfbuzzjs/hb.js").HarfBuzzModule) => unknown;
  export default hbjs;
}
