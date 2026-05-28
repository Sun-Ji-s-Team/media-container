declare module "@imgly/background-removal-node" {
  export function removeBackground(
    input: Buffer | Uint8Array | ArrayBuffer,
    options?: {
      output?: { format?: string };
    }
  ): Promise<Blob>;
}
