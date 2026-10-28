/**
 * WAV 载波：把 funscript 文本塞进一个 8-bit PCM 的 WAV 文件里。
 *
 * 为什么用 WAV 当载体：Studio 的素材管线不接受 `.funscript`，但接受
 * `assets/se/*.wav`，而且实测导入是**逐字节原样拷贝**（SHA-256 不变）。
 * WAV 的 `data` 块后面就是裸字节，没有压缩、没有色彩管理、没有有损编码，
 * 解码就是「跳过头部、读字节」，比 PNG 以像素承载更省事也更可靠。
 *
 * 文件布局（WAV 头之后的 data 块）：
 *
 * ```
 * 偏移  长度  含义
 * 0     4     魔数 "LGF1"
 * 4     1     版本，当前 1
 * 5     1     标志位，保留，写 0
 * 6     4     payload 字节数（uint32 小端）
 * 10    4     payload 的 CRC32（uint32 小端）
 * 14    N     payload：UTF-8 的 funscript JSON 文本
 * ```
 *
 * data 块长度为奇数时补一个 0 字节（RIFF 规范要求块对齐）。
 *
 * 注意：解析 WAV 时按块遍历，不假设固定 44 字节头——别的工具可能插入
 * LIST/INFO 之类的附加块。
 */

const MAGIC = "LGF1";
const FORMAT_VERSION = 1;
const HEADER_BYTES = 14; // magic + version + flags + length + crc
const SAMPLE_RATE = 44100;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  let table = crcTable;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

export interface CarrierInfo {
  /** funscript 文本。 */
  text: string;
  /** data 块里的总字节数。 */
  dataBytes: number;
  /** 原文的 UTF-8 字节数。 */
  payloadBytes: number;
}

/**
 * 从 WAV 字节里解出 funscript 文本。
 *
 * 失败时抛出中文错误，说明是「不是 WAV」「不是载体」「版本不对」还是
 * 「校验失败」，方便创作者判断是放错了文件还是文件被改过。
 */
export function decodeCarrierWav(input: ArrayBuffer | Uint8Array): CarrierInfo {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  if (bytes.length < 44) {
    throw new Error("文件太小，不是有效的 WAV。");
  }
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("不是 WAV 文件（RIFF/WAVE 标识不对）。");
  }
  if (readAscii(bytes, 12, 4) !== "fmt ") {
    throw new Error("WAV 结构异常：第一个块不是 fmt。");
  }

  // 遍历块，找 data
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = readU32(bytes, offset + 4);
    const body = offset + 8;
    if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2); // 块对齐
  }

  if (dataOffset < 0) {
    throw new Error("WAV 里找不到 data 块。");
  }
  if (dataOffset + dataSize > bytes.length) {
    throw new Error("WAV 的 data 块被截断，文件可能不完整。");
  }

  if (dataSize < HEADER_BYTES || readAscii(bytes, dataOffset, 4) !== MAGIC) {
    throw new Error(
      "这个 WAV 不是 OSR6 联动的脚本载体（缺少 LGF1 标识）。请用扩展自带的打包工具生成。",
    );
  }

  const version = bytes[dataOffset + 4];
  if (version !== FORMAT_VERSION) {
    throw new Error(`载体版本 ${version} 不受支持（当前只支持 ${FORMAT_VERSION}）。`);
  }

  const payloadLength = readU32(bytes, dataOffset + 6);
  const expectedCrc = readU32(bytes, dataOffset + 10);
  if (payloadLength > dataSize - HEADER_BYTES) {
    throw new Error("载体头部记录的长度超出了文件长度，文件可能被截断。");
  }

  const payload = bytes.subarray(
    dataOffset + HEADER_BYTES,
    dataOffset + HEADER_BYTES + payloadLength,
  );
  if (crc32(payload) !== expectedCrc) {
    throw new Error("载体校验失败（CRC 不匹配）：文件在打包后被改动过。");
  }

  const text = new TextDecoder().decode(payload);
  return { text, dataBytes: dataSize, payloadBytes: payloadLength };
}

/**
 * 把 funscript 文本打成 WAV 载波字节（工具脚本用）。
 *
 * 运行时会用到 decodeCarrierWav；encode 主要给 `npm run pack` 生成的
 * `tools/pack-funscript.mjs` 复用，保证打包和解包用的是同一份格式定义。
 */
export function encodeCarrierWav(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const dataBytes = HEADER_BYTES + payload.length;
  const padded = dataBytes + (dataBytes % 2);
  const total = 44 + padded;

  const buffer = new ArrayBuffer(total);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) bytes[offset + i] = value.charCodeAt(i);
  };

  ascii(0, "RIFF");
  writeU32(view, 4, total - 8);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  writeU32(view, 16, 16); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  writeU32(view, 24, SAMPLE_RATE);
  writeU32(view, 28, SAMPLE_RATE); // byteRate = 采样率 × 1 声道 × 1 字节
  view.setUint16(32, 1, true); // blockAlign
  view.setUint16(34, 8, true); // 8 位
  ascii(36, "data");
  writeU32(view, 40, padded);

  ascii(44, MAGIC);
  bytes[48] = FORMAT_VERSION;
  bytes[49] = 0;
  writeU32(view, 50, payload.length);
  writeU32(view, 54, crc32(payload));
  bytes.set(payload, 58);

  return bytes;
}

