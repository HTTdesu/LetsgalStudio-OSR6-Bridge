declare module "virtual:osr6-serialport" {
  export interface EmbeddedBinary {
    platform: string;
    architectures: string[];
    armVersion?: string;
    libc?: string;
    sha256: string;
    gzip: string;
  }
  export const binaries: EmbeddedBinary[];
  export function createSerialPort(
    require: (name: string) => unknown,
    process: NodeJS.Process,
    Buffer: typeof import("node:buffer").Buffer,
    nativeBinding: object,
  ): typeof import("serialport").SerialPort;
}
