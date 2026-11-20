declare module "tiny-buffer-rpc" {
  interface Encoding {
    preencode(state: unknown, value: unknown): void;
    encode(state: unknown, value: unknown): void;
    decode(state: unknown): unknown;
  }
  interface Method {
    request(value: unknown): Promise<unknown>;
    createRequestStream(): import("node:stream").Duplex;
  }
  export default class RPC {
    constructor(send: (message: Buffer) => void);
    register(
      id: number,
      options: { request: Encoding; response: Encoding },
    ): Method;
    recv(message: Buffer): void;
    destroy(): void;
  }
}
declare module "tiny-buffer-rpc/any.js" {
  const codec: {
    preencode(state: unknown, value: unknown): void;
    encode(state: unknown, value: unknown): void;
    decode(state: unknown): unknown;
  };
  export default codec;
}
declare module "fs-native-extensions" {
  export function tryLock(fd: number): boolean;
  export function unlock(fd: number): void;
}
declare module "z32" {
  const z32: {
    encode(value: Uint8Array): string;
    decode(value: string): Buffer;
  };
  export default z32;
}
