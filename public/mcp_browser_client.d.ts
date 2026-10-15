declare namespace wasm_bindgen {
	/* tslint:disable */
	/* eslint-disable */
	export function get_timestamp(): bigint;
	export function get_uptime(): bigint;
	export function increment_uptime(): void;
	/**
	 * Reads a resource and returns the JSON-RPC `result`, `{contents}`.
	 */
	export function read_resource(url: string, uri: string, options: string): Promise<string>;
	/**
	 * Returns `{prompts}`, every page of the server's prompt list.
	 */
	export function list_prompts(url: string, options: string): Promise<string>;
	/**
	 * Gets a prompt with JSON-encoded arguments and returns the JSON-RPC `result`,
	 * `{description?, messages}`.
	 */
	export function get_prompt(url: string, name: string, args: string, options: string): Promise<string>;
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
	export function get_version(): string;
	export function get_compiled_info(): string;
	/**
	 * Sends the module's log entries to `logger` instead of the console. It's called with one
	 * JSON string per entry: `{level, server, message, detail?}`.
	 */
	export function set_logger(logger: Function): void;
	export function get_metadata(): string;
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
	/**
	 * Returns `{resources}`, every page of the server's resource list.
	 */
	export function list_resources(url: string, options: string): Promise<string>;
	/**
	 * Returns `{resourceTemplates}`, every page of the server's resource template list.
	 */
	export function list_resource_templates(url: string, options: string): Promise<string>;
	
}

declare type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

declare interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly auth_begin: (a: number, b: number, c: number, d: number) => any;
  readonly auth_finish: (a: number, b: number, c: number, d: number) => any;
  readonly auth_refresh: (a: number, b: number) => any;
  readonly call_tool: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
  readonly connect: (a: number, b: number, c: number, d: number) => any;
  readonly forget_server: (a: number, b: number) => void;
  readonly get_compiled_info: () => [number, number];
  readonly get_metadata: () => [number, number];
  readonly get_prompt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
  readonly get_timestamp: () => bigint;
  readonly get_uptime: () => bigint;
  readonly get_version: () => [number, number];
  readonly increment_uptime: () => void;
  readonly list_prompts: (a: number, b: number, c: number, d: number) => any;
  readonly list_resource_templates: (a: number, b: number, c: number, d: number) => any;
  readonly list_resources: (a: number, b: number, c: number, d: number) => any;
  readonly list_tools: (a: number, b: number, c: number, d: number) => any;
  readonly read_resource: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
  readonly set_logger: (a: any) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_1: WebAssembly.Table;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_5: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly _dyn_core_608f92abc48d28da___ops__function__FnMut_____Output______as_wasm_bindgen_68aa18c3e367eca1___closure__WasmClosure___describe__invoke______: (a: number, b: number) => void;
  readonly closure121_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure145_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
