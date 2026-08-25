export class BoundedBuffer {
  #chunks = [];
  #limit;
  #receivedBytes = 0;

  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error('buffer limit must be a non-negative safe integer');
    }
    this.#limit = limit;
  }

  get overflowed() {
    return this.#receivedBytes > this.#limit;
  }

  get receivedBytes() {
    return this.#receivedBytes;
  }

  append(chunk) {
    if (this.overflowed) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#receivedBytes += buffer.length;
    if (this.overflowed) return false;
    this.#chunks.push(buffer);
    return true;
  }

  toBuffer() {
    return Buffer.concat(this.#chunks);
  }

  toString(encoding = 'utf8') {
    return this.toBuffer().toString(encoding);
  }
}
