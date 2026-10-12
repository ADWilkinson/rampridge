/** Randomness the API draws on, injectable so tests are repeatable. */

export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
