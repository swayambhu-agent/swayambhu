#!/usr/bin/env node
// Sign a message or rotation request with the patron's Ed25519 private key.
//
// Usage:
//   node scripts/patron-sign.mjs "challenge message"
//   node scripts/patron-sign.mjs --rotate "ssh-ed25519 AAAA... new key"
//   node scripts/patron-sign.mjs --key ~/.ssh/other_key "message"

import { readFileSync } from "fs";
import { createPrivateKey, sign } from "node:crypto";
import { resolve } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
let keyPath = resolve(homedir(), ".ssh/id_ed25519");
let rotateMode = false;
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key" && args[i + 1]) {
    keyPath = resolve(args[++i]);
  } else if (args[i] === "--rotate") {
    rotateMode = true;
  } else {
    positional.push(args[i]);
  }
}

if (positional.length !== 1) {
  console.error("Usage: patron-sign.mjs [--key path] [--rotate] <message or new-public-key>");
  process.exit(1);
}

const input = positional[0];
const message = rotateMode ? `rotate:${input}` : input;

const pemData = readFileSync(keyPath, "utf8");
const privateKey = createPrivateKey({ key: pemData, format: "pem" });

if (privateKey.asymmetricKeyType !== "ed25519") {
  console.error(`Error: key at ${keyPath} is ${privateKey.asymmetricKeyType}, expected ed25519`);
  process.exit(1);
}

const signature = sign(null, Buffer.from(message), privateKey);
console.log(signature.toString("base64"));
