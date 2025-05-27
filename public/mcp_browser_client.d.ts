declare namespace wasm_bindgen {
	/* tslint:disable */
	/* eslint-disable */
	export function get_timestamp(): bigint;
	export function get_uptime(): bigint;
	export function increment_uptime(): void;
	export function get_version(): string;
	export function health_check(): Promise<number>;
	export function handle_message(message: string): Promise<number>;
	export function get_metadata(): string;
	export function add_memory_event(text: string): void;
	export function clear_memory_events(): void;
	
}

declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly get_timestamp: () => bigint;
  readonly get_uptime: () => bigint;
  readonly increment_uptime: () => void;
  readonly get_version: () => [number, number];
  readonly health_check: () => any;
  readonly handle_message: (a: number, b: number) => any;
  readonly get_metadata: () => [number, number, number, number];
  readonly add_memory_event: (a: number, b: number) => [number, number];
  readonly clear_memory_events: () => [number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure31_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure53_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
declare function wasm_bindgen (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
