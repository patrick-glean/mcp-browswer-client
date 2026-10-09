// Just enough of the ZIP format for an app's download: writing files stored as they are, and
// reading them back stored or deflated (as zip tools on every OS make them).

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS time and date, which ZIP records in local time with two-second steps.
function dosTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

// files: [{ name, data: string | Uint8Array }]. Names are UTF-8 (flag bit 11).
export function zip(files, { date = new Date() } = {}) {
    const { time, day } = dosTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const file of files) {
        const name = encoder.encode(file.name);
        const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint16(8, 0, true);
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        locals.push(new Uint8Array(local.buffer), name, data);
        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(8, 0x0800, true);
        central.setUint16(10, 0, true);
        central.setUint16(12, time, true);
        central.setUint16(14, day, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, name.length, true);
        central.setUint32(42, offset, true);
        centrals.push(new Uint8Array(central.buffer), name);
        offset += 30 + name.length + data.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The files in a zip, by name: Map<name, Uint8Array>. Folders are left out.
export async function unzip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
        if (view.getUint32(at, true) === 0x06054b50) {
            end = at;
            break;
        }
    }
    if (end < 0) throw new Error("That isn't a zip file.");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The zip file is damaged: its list of files is unreadable.');
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        const crc = view.getUint32(at + 16, true);
        const compressedSize = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) continue;
        if (flags & 0x1) throw new Error(`${name} in the zip is encrypted.`);
        if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`The zip file is damaged at ${name}.`);
        const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const raw = bytes.subarray(dataStart, dataStart + compressedSize);
        let data;
        if (method === 0) data = raw.slice();
        else if (method === 8) data = await inflateRaw(raw);
        else throw new Error(`${name} in the zip is compressed in a way this client can't read (method ${method}).`);
        if (crc32(data) !== crc) throw new Error(`${name} in the zip is damaged (its checksum doesn't match).`);
        files.set(name, data);
    }
    return files;
}
