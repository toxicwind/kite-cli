// @toxicwind/kite/noise — Bun port of the PROVEN python Noise_XX toolkit
// (noise_build/noise_protocol.py, 58/58 tests; RE'd from muse.ai gateway
// telemetry, corrected 2026-09-30: AES-256-GCM, not ChaChaPoly).
//
// Two handshake modes, byte-for-byte:
//   custom  (muse.ai client RE): msg3 = second ephemeral e2 + DH(e2, re),
//           nonce = [0x00]*4 || u32be(hi) || u32be(lo)
//   standard (spec Noise XX):    msg3 = s, se;
//           nonce = [0x00]*4 || u64le
// Only dependency: node:crypto.

import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  diffieHellman, generateKeyPairSync, createPrivateKey, createPublicKey,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

export const PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256";
export type NonceStyle = "custom" | "standard";

// --- raw x25519 helpers (DER envelopes, last 32 bytes are the raw key) ---
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function x25519Generate(): { private: KeyObject; publicRaw: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { private: privateKey, publicRaw: rawPublic(publicKey) };
}

export function rawPublic(k: KeyObject): Buffer {
  return Buffer.from(k.export({ type: "spki", format: "der" })).subarray(-32);
}

function importPublicRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function importPrivateRaw(raw: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

function dh(priv: KeyObject, peerPublicRaw: Buffer): Buffer {
  return Buffer.from(diffieHellman({ privateKey: priv, publicKey: importPublicRaw(peerPublicRaw) }));
}

// --- CipherState: AES-256-GCM with 64-bit counter ---
export class CipherState {
  nonce = 0;
  constructor(private key: Buffer | null = null, private style: NonceStyle = "custom") {}

  hasKey() { return this.key !== null; }
  setKey(k: Buffer) {
    if (k.length !== 32) throw new Error("AESGCM key must be exactly 32 bytes");
    this.key = k; this.nonce = 0;
  }

  private nonceBytes(n: number): Buffer {
    const b = Buffer.alloc(12);
    if (this.style === "standard") {
      b.writeUInt32LE(n % 0x100000000, 4);
      b.writeUInt32LE(Math.floor(n / 0x100000000), 8);
    } else { // custom: [0]*4 || u32be(hi) || u32be(lo)
      b.writeUInt32BE(Math.floor(n / 0x100000000), 4);
      b.writeUInt32BE(n % 0x100000000, 8);
    }
    return b;
  }

  encryptWithAd(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.hasKey()) return plaintext;
    const c = createCipheriv("aes-256-gcm", this.key!, this.nonceBytes(this.nonce));
    const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]); // python AESGCM: ct||tag
    this.nonce++;
    return ct;
  }

  decryptWithAd(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.hasKey()) return ciphertext;
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const d = createDecipheriv("aes-256-gcm", this.key!, this.nonceBytes(this.nonce));
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
    this.nonce++;
    return pt;
  }
}

// --- SymmetricState ---
export class SymmetricState {
  ck: Buffer; h: Buffer;
  cs: CipherState;
  constructor(protocolName = PROTOCOL_NAME, nonceStyle: NonceStyle = "custom") {
    this.cs = new CipherState(null, nonceStyle);
    const pn = Buffer.from(protocolName);
    this.h = pn.length <= 32 ? Buffer.concat([pn, Buffer.alloc(32 - pn.length)]) : createHash("sha256").update(pn).digest();
    this.ck = this.h;
  }
  private hmac(key: Buffer, ...parts: Buffer[]): Buffer {
    const hm = createHmac("sha256", key);
    for (const p of parts) hm.update(p);
    return hm.digest();
  }
  mixKey(ikm: Buffer) {
    const prk = this.hmac(this.ck, ikm);
    const t1 = this.hmac(prk, Buffer.from([1]));
    const t2 = this.hmac(prk, t1, Buffer.from([2]));
    this.ck = t1;
    this.cs.setKey(t2.subarray(0, 32));
  }
  mixHash(data: Buffer) {
    this.h = createHash("sha256").update(this.h).update(data).digest();
  }
  mixKeyAndHash(ikm: Buffer) {
    const prk = this.hmac(this.ck, ikm);
    const t1 = this.hmac(prk, Buffer.from([1]));
    const t2 = this.hmac(prk, t1, Buffer.from([2]));
    const t3 = this.hmac(prk, t2, Buffer.from([3]));
    this.ck = t1; this.mixHash(t2); this.cs.setKey(t3.subarray(0, 32));
  }
  encryptAndHash(pt: Buffer): Buffer {
    const ct = this.cs.encryptWithAd(this.h, pt);
    this.mixHash(ct);
    return ct;
  }
  decryptAndHash(ct: Buffer): Buffer {
    const pt = this.cs.decryptWithAd(this.h, ct);
    this.mixHash(ct);
    return pt;
  }
  split(): [CipherState, CipherState] {
    const prk = this.hmac(this.ck);
    const t1 = this.hmac(prk, Buffer.from([1]));
    const t2 = this.hmac(prk, t1, Buffer.from([2]));
    return [new CipherState(t1.subarray(0, 32), this.cs["style"]),
            new CipherState(t2.subarray(0, 32), this.cs["style"])];
  }
}

export interface NoiseKeys { private: KeyObject; publicRaw: Buffer; }

// --- NoiseHandshakeState (custom + standard) ---
export class NoiseHandshakeState {
  isInitiator: boolean;
  mode: "custom" | "standard";
  staticKey: NoiseKeys;
  ephemeral: NoiseKeys;
  ss: SymmetricState;
  remoteStatic: Buffer | null = null;
  remoteEphemeral: Buffer | null = null;
  stage = 0;
  completed = false;

  constructor(opts: { isInitiator: boolean; mode?: "custom" | "standard"; staticKey?: NoiseKeys }) {
    this.isInitiator = opts.isInitiator;
    this.mode = opts.mode ?? "custom";
    this.staticKey = opts.staticKey ?? x25519Generate();
    this.ephemeral = x25519Generate();
    const style: NonceStyle = this.mode === "standard" ? "standard" : "custom";
    this.ss = new SymmetricState(PROTOCOL_NAME, style);
  }

  /** -> e */
  writeMsg1(payload = Buffer.alloc(0)): Buffer {
    if (!this.isInitiator || this.stage !== 0) throw new Error("writeMsg1 only valid for initiator at stage 0");
    const e = this.ephemeral.publicRaw;
    this.ss.mixHash(e);
    const msg = Buffer.concat([e, this.ss.encryptAndHash(payload)]);
    this.stage = 1;
    return msg;
  }

  readMsg1(msg: Buffer): Buffer {
    if (this.isInitiator || this.stage !== 0) throw new Error("readMsg1 only valid for responder at stage 0");
    if (msg.length < 32) throw new Error("Message 1 too short for X25519 public key");
    this.remoteEphemeral = msg.subarray(0, 32);
    this.ss.mixHash(this.remoteEphemeral);
    const payload = this.ss.decryptAndHash(msg.subarray(32));
    this.stage = 1;
    return payload;
  }

  /** <- e, ee, s, es (responder writes / initiator reads) */
  writeMsg2(payload = Buffer.alloc(0)): Buffer {
    if (this.isInitiator || this.stage !== 1) throw new Error("writeMsg2 only valid for responder at stage 1");
    const e = this.ephemeral.publicRaw;
    this.ss.mixHash(e);
    this.ss.mixKey(dh(this.ephemeral.private, this.remoteEphemeral!));       // ee
    const sEnc = this.ss.encryptAndHash(this.staticKey.publicRaw);           // s (encrypted)
    this.ss.mixKey(dh(this.staticKey.private, this.remoteEphemeral!));       // es
    const out = Buffer.concat([e, sEnc, this.ss.encryptAndHash(payload)]);
    this.stage = 2;
    return out;
  }

  readMsg2(msg: Buffer): Buffer {
    if (!this.isInitiator || this.stage !== 1) throw new Error("readMsg2 only valid for initiator at stage 1");
    if (msg.length < 80) throw new Error("Message 2 too short");
    this.remoteEphemeral = msg.subarray(0, 32);
    this.ss.mixHash(this.remoteEphemeral);
    this.ss.mixKey(dh(this.ephemeral.private, this.remoteEphemeral!));       // ee
    this.remoteStatic = this.ss.decryptAndHash(msg.subarray(32, 80));        // s
    this.ss.mixKey(dh(this.ephemeral.private, this.remoteStatic));           // es
    const payload = this.ss.decryptAndHash(msg.subarray(80));
    this.stage = 2;
    return payload;
  }

  /** -> s, se (standard) | -> e2, DH(e2, re) (custom); splits transport. */
  writeMsg3(payload = Buffer.alloc(0)): { msg: Buffer; send: CipherState; recv: CipherState } {
    if (!this.isInitiator || this.stage !== 2) throw new Error("writeMsg3 only valid for initiator at stage 2");
    let out: Buffer;
    if (this.mode === "standard") {
      const sEnc = this.ss.encryptAndHash(this.staticKey.publicRaw);         // s
      this.ss.mixKey(dh(this.staticKey.private, this.remoteEphemeral!));     // se
      out = Buffer.concat([sEnc, this.ss.encryptAndHash(payload)]);
    } else {
      const e2 = x25519Generate();                                           // e2 (custom RE variant)
      const e2Enc = this.ss.encryptAndHash(e2.publicRaw);
      this.ss.mixKey(dh(e2.private, this.remoteEphemeral!));                 // DH(e2, re)
      out = Buffer.concat([e2Enc, this.ss.encryptAndHash(payload)]);
    }
    this.stage = 3; this.completed = true;
    const [send, recv] = this.ss.split();
    return { msg: out, send, recv };
  }

  /** Responder side completion: reads msg3, splits transport. */
  readMsg3(msg: Buffer): { payload: Buffer; send: CipherState; recv: CipherState } {
    if (this.isInitiator || this.stage !== 2) throw new Error("readMsg3 only valid for responder at stage 2");
    let payload: Buffer;
    if (this.mode === "standard") {
      this.remoteStatic = this.ss.decryptAndHash(msg.subarray(0, 48));
      this.ss.mixKey(dh(this.ephemeral.private, this.remoteStatic));         // se
      payload = this.ss.decryptAndHash(msg.subarray(48));
    } else {
      const e2 = this.ss.decryptAndHash(msg.subarray(0, 48));                // e2
      this.ss.mixKey(dh(this.ephemeral.private, e2));                        // DH(re, e2)
      payload = this.ss.decryptAndHash(msg.subarray(48));
    }
    this.stage = 3; this.completed = true;
    // responder transport: c1 decrypts first, c2 encrypts first (split symmetric)
    const [c1, c2] = this.ss.split();
    return { payload, send: c2, recv: c1 };
  }
}
