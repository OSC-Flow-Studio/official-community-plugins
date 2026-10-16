// OSC 1.0 encoding for the one message a Giggle Puck understands: an int32 motor value.

/** An OSC string: ASCII bytes, at least one NUL, padded to a multiple of 4 bytes. */
function oscString(text) {
  const bytes = Buffer.from(text, "ascii");
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / 4) * 4);
  bytes.copy(padded);
  return padded;
}

/** `address ,i value` as one OSC message. The value is truncated to a 32-bit integer. */
export function encodeOscInt(address, value) {
  if (typeof address !== "string" || !address.startsWith("/")) throw new Error("OSC address must start with /");
  const argument = Buffer.alloc(4);
  argument.writeInt32BE(Math.trunc(value) | 0);
  return Buffer.concat([oscString(address), oscString(",i"), argument]);
}
