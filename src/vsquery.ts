/**
 * Vintage Story Server Query
 * Protocol: protobuf over TCP, 4-byte BE length prefix per packet.
 * Port of vs_sniff.py to TypeScript.
 */

// ─── Protobuf varint ─────────────────────────────────────────────────

function writeVarint(value: number): number[] {
  const result: number[] = [];
  while (true) {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) {
      byte |= 0x80;
    }
    result.push(byte);
    if (value === 0) break;
  }
  return result;
}

function readVarint(
  data: Uint8Array,
  offset: number = 0,
): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < data.length) {
    const byte = data[i];
    value |= (byte & 0x7f) << shift;
    i++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return [value, i - offset];
}

// ─── Wire format helpers ────────────────────────────────────────────

function wireString(tag: number, value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value);
  const tagBytes = writeVarint((tag << 3) | 2);
  const lenBytes = writeVarint(encoded.length);
  const total = new Uint8Array(tagBytes.length + lenBytes.length + encoded.length);
  total.set(tagBytes, 0);
  total.set(lenBytes, tagBytes.length);
  total.set(encoded, tagBytes.length + lenBytes.length);
  return total;
}

function wireVarint(tag: number, value: number): Uint8Array {
  const tagBytes = writeVarint((tag << 3) | 0);
  const valBytes = writeVarint(value);
  const total = new Uint8Array(tagBytes.length + valBytes.length);
  total.set(tagBytes, 0);
  total.set(valBytes, tagBytes.length);
  return total;
}

function wireMessage(tag: number, message: Uint8Array): Uint8Array {
  const tagBytes = writeVarint((tag << 3) | 2);
  const lenBytes = writeVarint(message.length);
  const total = new Uint8Array(tagBytes.length + lenBytes.length + message.length);
  total.set(tagBytes, 0);
  total.set(lenBytes, tagBytes.length);
  total.set(message, tagBytes.length + lenBytes.length);
  return total;
}

function concatArrays(...arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  const totalLen = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ─── Packet builders ────────────────────────────────────────────────

export interface ClientIdentificationOpts {
  gameVersion?: string;
  playerName?: string;
  mpToken?: string;
  serverPassword?: string;
  playerUid?: string;
  viewDistance?: number;
  networkVersion?: string;
  shortGameVersion?: string;
}

function buildClientIdentification(opts: ClientIdentificationOpts = {}): Uint8Array {
  const {
    gameVersion = "1.99.99",
    playerName = "ServerSniffer",
    mpToken = "",
    serverPassword = "",
    playerUid = "sniffer",
    viewDistance = 128,
    networkVersion = "999.99.99",
    shortGameVersion = "1.99.99",
  } = opts;

  const parts: Uint8Array[] = [];
  parts.push(wireString(1, gameVersion));
  parts.push(wireString(2, playerName));
  if (mpToken) parts.push(wireString(3, mpToken));
  if (serverPassword) parts.push(wireString(4, serverPassword));
  parts.push(wireString(6, playerUid));
  parts.push(wireVarint(7, viewDistance));
  parts.push(wireString(9, networkVersion));
  parts.push(wireString(10, shortGameVersion));
  return concatArrays(...parts);
}

function buildPacketClient(identification: Uint8Array): Uint8Array {
  return wireMessage(2, identification);
}

function buildWirePacket(payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, len, false); // big-endian
  return concatArrays(header, payload);
}

// ─── Network I/O ────────────────────────────────────────────────────

async function sendPacketRaw(
  host: string,
  port: number,
  wire: Uint8Array,
  timeout: number = 8000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let socket: ReturnType<typeof Bun.connect>;

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      resolve(concatArrays(...chunks));
      try { (await socket)?.end(); } catch { }
    }, timeout);

    socket = Bun.connect({
      hostname: host,
      port,
      socket: {
        open(_socket) {
          _socket.write(wire);
        },
        data(_socket, incoming: Uint8Array) {
          chunks.push(new Uint8Array(incoming));
        },
        close(_socket) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(concatArrays(...chunks));
          }
        },
        error(_socket, err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new Error(err.message || String(err)));
          }
        },
        connectError(_socket, err) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new Error(err?.message || "Connection refused"));
          }
        },
        drain(_socket) { },
        end(_socket) { },
      },
    });
  });
}

// ─── Response parsing ───────────────────────────────────────────────

interface ParsedProtobuf {
  [key: string]: string | number | ParsedProtobuf;
}

function parseProtobuf(payload: Uint8Array): ParsedProtobuf {
  const result: ParsedProtobuf = {};
  let offset = 0;
  while (offset < payload.length) {
    let wireTag: number, consumed: number;
    try {
      [wireTag, consumed] = readVarint(payload, offset);
    } catch {
      break;
    }
    offset += consumed;
    const tag = wireTag >>> 3;
    const wireType = wireTag & 0x07;

    if (wireType === 0) {
      // varint
      let val: number;
      [val, consumed] = readVarint(payload, offset);
      offset += consumed;
      result[`int_${tag}`] = val;
    } else if (wireType === 2) {
      // length-delimited
      let length: number;
      [length, consumed] = readVarint(payload, offset);
      offset += consumed;
      const raw = payload.slice(offset, offset + length);
      offset += length;
      try {
        result[`str_${tag}`] = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        // Try nested protobuf
        const nested = parseProtobuf(raw);
        if (Object.keys(nested).length > 0) {
          result[`msg_${tag}`] = nested;
        } else {
          result[`hex_${tag}`] = Array.from(raw).map(b => b.toString(16).padStart(2, "0")).join("");
        }
      }
    } else {
      // Unknown wire type, stop
      break;
    }
  }
  return result;
}

function parseResponsePackets(data: Uint8Array): ParsedProtobuf[] {
  const packets: ParsedProtobuf[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const pktLen = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
    if (pktLen <= 0 || offset + 4 + pktLen > data.length) break;
    const payload = data.slice(offset + 4, offset + 4 + pktLen);
    const parsed = parseProtobuf(payload);
    packets.push(parsed);
    offset += 4 + pktLen;
  }
  return packets;
}

// ─── Info extraction ────────────────────────────────────────────────

function extractStringsRecursive(obj: ParsedProtobuf | ParsedProtobuf[]): string[] {
  const strings: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) strings.push(...extractStringsRecursive(item));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("str_")) {
        strings.push(v as string);
      } else if (typeof v === "object") {
        strings.push(...extractStringsRecursive(v as ParsedProtobuf | ParsedProtobuf[]));
      }
    }
  }
  return strings;
}

export interface ServerInfo {
  serverGameVersion?: string;
  serverNetworkVersion?: string;
  passwordProtected?: boolean;
  whitelisted?: boolean;
  banned?: boolean;
  serverFull?: boolean;
  authRequired?: boolean;
  passwordValid?: boolean;
  loginToken?: string;
  disconnectMessage?: string | null;
  rawHex?: string;
  rawLength?: number;
  error?: string;
}

function extractServerMessages(packets: ParsedProtobuf[]): Partial<ServerInfo> {
  const info: Partial<ServerInfo> = {};
  const allStrings = extractStringsRecursive(packets);
  const fullText = allStrings.join("");

  // Version from "wrong version" disconnect
  const verMatch = fullText.match(/Server:\s*v?([\d.]+)/);
  if (verMatch) info.serverGameVersion = verMatch[1];

  const nvMatch = fullText.match(/Server:.*?\(nv:\s*([\d.]+)\)/);
  if (nvMatch) info.serverNetworkVersion = nvMatch[1];

  // Status flags
  if (/password/i.test(fullText)) {
    info.passwordProtected = true;
    if (/invalid/i.test(fullText)) info.passwordValid = false;
  };
  if (/whitelist/i.test(fullText)) info.whitelisted = true;
  if (/banned/i.test(fullText)) info.banned = true;
  if (/queue/i.test(fullText) || /full/i.test(fullText)) info.serverFull = true;
  if (/bad game session/i.test(fullText)) {
    info.authRequired = true;
    info.passwordProtected = true;
    info.passwordValid = true;
  }

  // Token
  for (const p of packets) {
    if (p["str_2"]) {
      info.loginToken = p["str_2"] as string;
    }
  }

  return info;
}

// ─── Main query ─────────────────────────────────────────────────────

export async function queryServer(
  host: string,
  port: number = 42420,
  timeout: number = 8000,
  password: string = "",
  version: string = "1.99.99",
  networkVersion: string = "999.99.99",
): Promise<ServerInfo> {
  const ident = buildClientIdentification({
    serverPassword: password,
    gameVersion: version,
    networkVersion: networkVersion,
  });

  const pkt = buildPacketClient(ident);
  const wire = buildWirePacket(pkt);

  let data: Uint8Array;
  try {
    data = await sendPacketRaw(host, port, wire, timeout);
  } catch (e) {
    return { error: (e as Error).message };
  }

  if (!data || data.length === 0) {
    return { error: "No response from server" };
  }

  const packets = parseResponsePackets(data);
  const info = extractServerMessages(packets);

  return {
    ...info,
  };
}
