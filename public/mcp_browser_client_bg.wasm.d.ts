/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const get_timestamp: () => bigint;
export const get_uptime: () => bigint;
export const increment_uptime: () => void;
export const get_version: () => [number, number];
export const health_check: () => any;
export const handle_message: (a: number, b: number) => any;
export const get_metadata: () => [number, number, number, number];
export const add_memory_event: (a: number, b: number) => [number, number];
export const clear_memory_events: () => [number, number];
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_export_2: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_export_5: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_table_dealloc: (a: number) => void;
export const closure31_externref_shim: (a: number, b: number, c: any) => void;
export const closure53_externref_shim: (a: number, b: number, c: any, d: any) => void;
export const __wbindgen_start: () => void;
