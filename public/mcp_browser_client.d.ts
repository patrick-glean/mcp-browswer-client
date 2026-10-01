declare namespace wasm_bindgen {
	/* tslint:disable */
	/* eslint-disable */
	export function get_timestamp(): bigint;
	export function get_uptime(): bigint;
	export function increment_uptime(): void;
	export function get_version(): string;
	export function get_compiled_info(): string;
	/**
	 * Sends the module's log entries to `logger` instead of the console. It's called with one
	 * JSON string per entry: `{level, server, message, detail?}`.
	 */
	export function set_logger(logger: Function): void;
	export function get_metadata(): string;
	export function add_memory_event(text: string): void;
	export function clear_memory_events(): void;
	export function get_bootrom(): string;
	/**
	 * Detects the server's protocol era and returns what it reported about itself:
	 * `{url, era, protocolVersion, serverInfo, capabilities, instructions}`.
	 */
	export function connect(url: string, options: string): Promise<string>;
	/**
	 * Returns `{tools, rejected, ttlMs, cacheScope, fromCache}`. Pass `{"refresh": true}` in
	 * `options` to skip the cache.
	 */
	export function list_tools(url: string, options: string): Promise<string>;
	/**
	 * Calls a tool with JSON-encoded arguments and returns the JSON-RPC `result`.
	 */
	export function call_tool(url: string, name: string, args: string, options: string): Promise<string>;
	export function forget_server(url: string): void;
	/**
	 * Starts signing in to a server that needs OAuth: discovery, client registration if needed,
	 * and the URL to open. `options` is `{redirectUri, applicationType, clients, wwwAuthenticate?}`;
	 * returns `{authorizationUrl, pending, client, newClient, authServer, scope}`.
	 */
	export function auth_begin(server_url: string, options: string): Promise<string>;
	/**
	 * Finishes a sign-in with the callback's `{code, state, iss, error, errorDescription}` and
	 * returns the tokens to store.
	 */
	export function auth_finish(pending: string, callback: string): Promise<string>;
	/**
	 * Refreshes stored tokens. Rejects with kind `auth_required` when the user has to sign in again.
	 */
	export function auth_refresh(tokens: string): Promise<string>;
	
}

declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly get_timestamp: () => bigint;
  readonly get_uptime: () => bigint;
  readonly increment_uptime: () => void;
  readonly get_version: () => [number, number];
  readonly get_compiled_info: () => [number, number];
  readonly set_logger: (a: any) => void;
  readonly get_metadata: () => [number, number];
  readonly add_memory_event: (a: number, b: number) => void;
  readonly clear_memory_events: () => void;
  readonly get_bootrom: () => [number, number];
  readonly connect: (a: number, b: number, c: number, d: number) => any;
  readonly list_tools: (a: number, b: number, c: number, d: number) => any;
  readonly call_tool: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
  readonly forget_server: (a: number, b: number) => void;
  readonly auth_begin: (a: number, b: number, c: number, d: number) => any;
  readonly auth_finish: (a: number, b: number, c: number, d: number) => any;
  readonly auth_refresh: (a: number, b: number) => any;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_1: WebAssembly.Table;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly _dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h3c5941f0d731c178: (a: number, b: number) => void;
  readonly closure104_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure126_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
