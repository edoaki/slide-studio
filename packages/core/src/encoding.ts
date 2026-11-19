import { createHash } from "node:crypto";
import type { Diagnostic } from "../../contracts/src/desktop.js";
import { CoreError } from "./errors.js";

export interface TextEncoding {
  bom: boolean;
  doubleBom: boolean;
  eol: "lf" | "crlf" | "mixed";
  validUtf8: boolean;
  source: string;
  diagnostics: Diagnostic[];
}

const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** UI source is always UTF-8 text with LF and no leading BOM. */
export function normalizeSource(source: string): string {
  const withoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  return withoutBom.replace(/\r\n?/gu, "\n");
}

export function decodeDeckBytes(bytes: Buffer): TextEncoding {
  const bom = bytes.length >= 3
    && bytes[0] === BOM_BYTES[0]
    && bytes[1] === BOM_BYTES[1]
    && bytes[2] === BOM_BYTES[2];
  const body = bom ? bytes.subarray(3) : bytes;
  let decoded = "";
  let validUtf8 = true;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    validUtf8 = false;
    decoded = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
  }
  const doubleBom = decoded.startsWith("\uFEFF");

  const crlf = (decoded.match(/\r\n/gu) ?? []).length;
  const loneCr = (decoded.match(/\r(?!\n)/gu) ?? []).length;
  const loneLf = (decoded.match(/(?<!\r)\n/gu) ?? []).length;
  let eol: "lf" | "crlf" | "mixed";
  if (loneCr > 0 || (crlf > 0 && loneLf > 0)) eol = "mixed";
  else if (crlf > 0 && loneLf === 0) eol = "crlf";
  else eol = "lf";

  const diagnostics: Diagnostic[] = [];
  if (!validUtf8) {
    diagnostics.push({
      code: "INVALID_UTF8",
      severity: "error",
      message: "The deck source is not valid UTF-8 and is open read-only.",
    });
  }
  if (eol === "mixed") {
    diagnostics.push({
      code: "MIXED_EOL",
      severity: "warning",
      message: "The deck source mixes CRLF and LF line endings and is open read-only.",
    });
  }
  if (doubleBom) {
    diagnostics.push({
      code: "BOM",
      severity: "error",
      message: "The deck source contains a second leading BOM and is open read-only.",
    });
  }

  return {
    bom,
    doubleBom,
    eol,
    validUtf8,
    source: normalizeSource(decoded),
    diagnostics,
  };
}

export function encodeSourceForDeck(source: string, encoding: Pick<TextEncoding, "bom" | "eol">): Buffer {
  if (encoding.eol === "mixed") {
    throw new CoreError("READ_ONLY", "mixed line endings cannot be written safely");
  }
  const lf = normalizeSource(source);
  const text = encoding.eol === "crlf" ? lf.replace(/\n/gu, "\r\n") : lf;
  const body = Buffer.from(text, "utf8");
  return encoding.bom ? Buffer.concat([BOM_BYTES, body]) : body;
}
