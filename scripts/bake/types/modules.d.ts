// Declarations for untyped JavaScript dependencies of the bake.

declare module "java-random" {
  /** java.util.Random port (48-bit LCG), used for the client's synth noise table. */
  export default class JavaRandom {
    constructor(seed?: number);
    nextInt(bound?: number): number;
  }
}

declare module "bzip2" {
  const bzip2: {
    array(bytes: Uint8Array): unknown;
    simple(bits: unknown): Uint8Array;
  };
  export default bzip2;
}
