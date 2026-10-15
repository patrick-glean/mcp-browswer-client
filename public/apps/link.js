// An app in a link: the client's address with #run= and the app's DML, deflated and in base64url,
// so opening the link runs the app (index.html's launch mode) wherever the client is served. What
// follows # stays in the browser: it isn't sent to the server that serves the client.

export const RUN_HASH = '#run=';

// The client's root: where its index.html is, whatever page of it is open, as the address bar
// has it. The client and an app it runs load everything from there.
export const clientRoot = href => new URL('./', href).href;

const toBase64Url = bytes => {
    let binary = '';
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));

const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

export async function packApp(dml) {
    return toBase64Url(await through(new TextEncoder().encode(dml), new CompressionStream('deflate-raw')));
}

// The DML a link carries. Throws when the link was cut short or changed on the way.
export async function unpackApp(packed) {
    let bytes;
    try {
        bytes = fromBase64Url(decodeURIComponent(String(packed).trim()));
    } catch {
        throw new Error("the link isn't one MCP Browser Client made: the app in it has letters a link to an app doesn't");
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(await through(bytes, new DecompressionStream('deflate-raw')));
    } catch {
        throw new Error('the link was cut short or changed on the way, so the app in it is incomplete');
    }
}

// A link that runs the app (its DML on its own, with the HTML of its screen and parts inside) in
// the client at `root`.
export async function runLink(dml, root) {
    return `${root}${RUN_HASH}${await packApp(dml)}`;
}
