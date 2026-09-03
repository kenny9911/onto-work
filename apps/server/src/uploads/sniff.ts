import {
  UPLOAD_ALLOWED_CONTENT_TYPES,
  type UploadContentType,
} from "@agent-harness/contracts";

import { ApiHttpError } from "../http.js";

/**
 * Upload content classification.
 *
 * The client never declares a content type. The wire body is fixed to
 * `application/octet-stream`, so there is nothing to reconcile and no
 * declared-type spoofing to defend against at that layer: the server decides
 * what it received, from the bytes it received, and stores only its own
 * answer.
 *
 * v1 accepts UTF-8 text and nothing else. Classification is deliberately a
 * text-shape heuristic and *not* a format parser — there is no magic-number
 * table, no dependency, and no binary decoder anywhere in this file. A parser
 * CVE here would be remote code execution inside the trusted control plane,
 * which is the trade the design refuses to make.
 *
 * Two-stage contract, because the route tees bytes into the sniffer while it
 * pipes them to the cipher and never holds the whole body in memory:
 *
 * ```ts
 * const sniffer = new UploadSniffer({ filename });
 * for await (const chunk of body) sniffer.update(chunk); // may throw
 * const contentType = sniffer.finalize();                // may throw
 * ```
 *
 * `update` validates **every** byte: a NUL or an invalid sequence 19 MiB into
 * the stream rejects the upload exactly as a leading one does. Only the first
 * `UPLOAD_SNIFF_PREFIX_CHARS` characters are retained, and only to choose
 * between the allow-listed text types.
 *
 * Rejections, in the order they are checked, all as
 * `ApiHttpError(415, "unsupported_upload_type")`:
 *
 * - a NUL byte anywhere;
 * - any other C0 control byte or DEL, except TAB, LF, FF and CR. This is what
 *   turns a `PK\x03\x04` ZIP header — which is perfectly valid UTF-8 — into a
 *   rejection without a magic-number table, and it also covers the leading
 *   bytes of most binary containers;
 * - anything the strict WHATWG UTF-8 decoder refuses: invalid or truncated
 *   sequences, overlong encodings, and lone surrogates in their only possible
 *   byte form (WTF-8, e.g. `ED A0 80`).
 *
 * A zero-byte body throws `ApiHttpError(400, "upload_empty")` instead. The
 * route rejects `Content-Length: 0` before reading anything; this is the
 * backstop for a body that turns out to be empty anyway, so an empty file can
 * never be stored as `text/plain`.
 *
 * Everything that survives validation is text, so it always lands on the
 * allow-list; `text/plain` is the fallback when no shape is recognized.
 */

/**
 * Characters of decoded text retained for classification. Validation covers
 * the whole stream; only the retained prefix decides *which* text type.
 */
export const UPLOAD_SNIFF_PREFIX_CHARS = 4096;

/** Upper bound on records examined by the delimiter and JSON-lines detectors. */
const MAX_SAMPLED_RECORDS = 32;

/**
 * Narrows a persisted `content_type` column back to the allow-list.
 *
 * The `sniffedType -> extension` map lives in `paths.ts`
 * (`extensionForUploadContentType`) and is deliberately not duplicated here:
 * this module decides *what* a file is, and that module decides what a path
 * may be called.
 */
export function isAllowedUploadContentType(value: string): value is UploadContentType {
  return (UPLOAD_ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

export interface UploadSnifferOptions {
  /**
   * The client's display label. Used only where it *agrees* with the content:
   * to break a CSV/TSV tie, to accept a single-record delimited file, to lower
   * the Markdown threshold, and to prefer NDJSON over JSON for a one-record
   * file. It can never override what the bytes say.
   */
  filename?: string | null;
}

export class UploadSniffer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly extension: string | null;
  private prefix = "";
  private truncated = false;
  private seen = 0;
  private settled: { type: UploadContentType } | { error: ApiHttpError } | null = null;

  constructor(options: UploadSnifferOptions = {}) {
    this.extension = labelExtension(options.filename ?? null);
  }

  /** Bytes fed so far. The route counts its own; this is for diagnostics. */
  get bytesSeen(): number {
    return this.seen;
  }

  /**
   * Feeds the next chunk. Throws `ApiHttpError` the moment the stream stops
   * being UTF-8 text, so the caller can destroy the pipeline without reading
   * the rest of the body.
   */
  update(chunk: Uint8Array): void {
    if (this.settled) {
      if ("error" in this.settled) throw this.settled.error;
      throw new Error("UploadSniffer.update called after finalize");
    }
    if (chunk.length === 0) return;

    const forbidden = findForbiddenByte(chunk);
    if (forbidden) {
      throw this.fail(
        forbidden.byte === 0x00
          ? `Uploads must be UTF-8 text; this file contains a NUL byte at offset ${this.seen + forbidden.index}.`
          : `Uploads must be UTF-8 text; this file contains a control character at offset ${this.seen + forbidden.index}.`,
      );
    }

    let decoded: string;
    try {
      decoded = this.decoder.decode(chunk, { stream: true });
    } catch {
      throw this.fail("Uploads must be UTF-8 text; this file is not valid UTF-8.");
    }
    this.seen += chunk.length;
    this.retain(decoded);
  }

  /**
   * Ends the stream and returns the stored content type. Throws if the final
   * bytes are a truncated UTF-8 sequence, or if nothing was fed at all.
   */
  finalize(): UploadContentType {
    if (this.settled) {
      if ("error" in this.settled) throw this.settled.error;
      return this.settled.type;
    }

    try {
      // A no-argument decode ends the stream and rejects a dangling sequence.
      this.retain(this.decoder.decode());
    } catch {
      throw this.fail("Uploads must be UTF-8 text; this file ends mid-sequence.");
    }

    if (this.seen === 0) {
      const error = new ApiHttpError(400, "upload_empty", "The uploaded file is empty.");
      this.settled = { error };
      throw error;
    }

    const type = classifyPrefix({
      text: this.prefix,
      complete: !this.truncated,
      extension: this.extension,
    });
    this.settled = { type };
    return type;
  }

  private fail(message: string): ApiHttpError {
    const error = new ApiHttpError(415, "unsupported_upload_type", message);
    this.settled = { error };
    return error;
  }

  private retain(text: string): void {
    if (text.length === 0 || this.truncated) return;
    const room = UPLOAD_SNIFF_PREFIX_CHARS - this.prefix.length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (text.length <= room) {
      this.prefix += text;
      return;
    }
    // Never split a surrogate pair; the retained prefix is read as text.
    const lead = text.charCodeAt(room - 1);
    const end = lead >= 0xd800 && lead <= 0xdbff ? room - 1 : room;
    this.prefix += text.slice(0, end);
    this.truncated = true;
  }
}

/**
 * Whole-buffer convenience over the incremental API, for callers that already
 * hold the bytes (tests, and any future small in-process payload). The
 * streaming path is the real one — do not use this on a request body.
 */
export function sniffUploadContentType(
  bytes: Uint8Array,
  options: UploadSnifferOptions = {},
): UploadContentType {
  const sniffer = new UploadSniffer(options);
  sniffer.update(bytes);
  return sniffer.finalize();
}

/**
 * First byte that disqualifies the stream as text: NUL, any other C0 control,
 * or DEL. TAB, LF, FF and CR are the only control characters that legitimately
 * structure a text document.
 *
 * A raw byte scan is exact here: every byte below 0x80 encodes exactly itself
 * in UTF-8 (overlong forms such as `C0 80` are rejected by the decoder), so
 * this can never fire on a byte belonging to a multi-byte sequence.
 */
function findForbiddenByte(chunk: Uint8Array): { byte: number; index: number } | null {
  let index = 0;
  for (const byte of chunk) {
    if (byte >= 0x20 && byte !== 0x7f) {
      index += 1;
      continue;
    }
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return { byte, index };
    }
    index += 1;
  }
  return null;
}

/**
 * Lower-cased extension of a display label, or null. Deliberately parsed with
 * `lastIndexOf` rather than a regex: the label is untrusted and unbounded in
 * shape, and this way there is no pattern to backtrack. Any directory-looking
 * prefix is discarded — the label never reaches the filesystem, but nothing
 * here should reward a caller for putting a path in it either.
 */
function labelExtension(filename: string | null): string | null {
  if (!filename) return null;
  const trimmed = filename.trim();
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
  const dot = base.lastIndexOf(".");
  // `dot <= 0` also covers dotfiles such as `.bashrc`, which have no extension.
  if (dot <= 0 || dot === base.length - 1) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return extension.length <= 16 ? extension : null;
}

function classifyPrefix(input: {
  text: string;
  complete: boolean;
  extension: string | null;
}): UploadContentType {
  const { text, complete, extension } = input;
  const head = text.trimStart();

  if (looksLikeXml(head)) return "application/xml";

  const records = sampleRecords(text, complete);
  if (looksLikeJsonLines(records, extension)) return "application/x-ndjson";
  if (looksLikeJsonDocument(head, text, complete)) return "application/json";

  const delimited = classifyDelimited(text, complete, extension);
  if (delimited) return delimited;

  if (looksLikeMarkdown(text, extension)) return "text/markdown";

  return "text/plain";
}

const XML_START_TAG = /^<[A-Za-z_][A-Za-z0-9._:-]*[\s/>]/;

/**
 * A declaration, a doctype, or a leading element start tag. HTML satisfies the
 * last of these and is not separately recognized: `text/html` is not on the
 * allow-list, and nothing in v1 ever serves these bytes back to a browser
 * (§9 — when an endpoint is added it must send `nosniff` and
 * `Content-Disposition: attachment` regardless of the stored type).
 */
function looksLikeXml(head: string): boolean {
  if (!head.startsWith("<")) return false;
  if (head.startsWith("<?xml")) return true;
  if (head.slice(0, 9).toLowerCase() === "<!doctype") return true;
  return XML_START_TAG.test(head);
}

/** Non-blank records, with a possibly truncated trailing line discarded. */
function sampleRecords(text: string, complete: boolean): string[] {
  const lines = text.split("\n");
  if (!complete) lines.pop();
  const records: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(trimmed);
    if (records.length >= MAX_SAMPLED_RECORDS) break;
  }
  return records;
}

/**
 * Every sampled record is a self-contained JSON object or array. Two records
 * are required to tell NDJSON apart from a pretty-printed document (whose
 * first line, `{`, is not a complete value); a `.ndjson`/`.jsonl` label — the
 * one place it agrees with the content — accepts a single record.
 */
function looksLikeJsonLines(records: string[], extension: string | null): boolean {
  const minimum = extension === "ndjson" || extension === "jsonl" ? 1 : 2;
  if (records.length < minimum) return false;
  for (const record of records) {
    if (!record.startsWith("{") && !record.startsWith("[")) return false;
    try {
      JSON.parse(record);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A JSON document here is an object or an array. A bare scalar (`42`) is valid
 * JSON by RFC 8259 but is far likelier to be a line of text, so it stays
 * `text/plain`.
 *
 * When the whole body fit in the prefix, `JSON.parse` decides. When it did not,
 * the prefix must still be an *open* JSON document — a prefix that already
 * closed has trailing content and is therefore not one document.
 */
function looksLikeJsonDocument(head: string, text: string, complete: boolean): boolean {
  if (!head.startsWith("{") && !head.startsWith("[")) return false;
  if (complete) {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }
  return scanJsonPrefix(text) === "prefix";
}

function classifyDelimited(
  text: string,
  complete: boolean,
  extension: string | null,
): UploadContentType | null {
  const wantsTsv = extension === "tsv" || extension === "tab";
  const wantsCsv = extension === "csv";
  const comma = delimiterProfile(text, ",", complete);
  const tab = delimiterProfile(text, "\t", complete);

  if (comma.consistent && tab.consistent) {
    // Both fit; the label is the tie-break, comma the default.
    return wantsTsv ? "text/tab-separated-values" : "text/csv";
  }
  if (comma.consistent) return "text/csv";
  if (tab.consistent) return "text/tab-separated-values";
  // A single record is only evidence when the label says the same thing.
  if (wantsCsv && comma.single) return "text/csv";
  if (wantsTsv && tab.single) return "text/tab-separated-values";
  return null;
}

interface DelimiterScan {
  /** Delimiter count of each newline-terminated, non-blank record. */
  terminated: number[];
  /** Delimiter count of a trailing record with no newline, or null. */
  trailing: number | null;
}

/**
 * Counts delimiters per record, honouring RFC 4180 quoting. Toggling on every
 * `"` handles the doubled-quote escape for free: `""` toggles twice and leaves
 * the scanner inside the field, which is exactly right, and a newline inside a
 * quoted field does not end the record.
 */
function scanDelimiter(text: string, delimiter: string): DelimiterScan {
  const terminated: number[] = [];
  let count = 0;
  let blank = true;
  let inQuotes = false;

  for (const character of text) {
    if (character === '"') {
      inQuotes = !inQuotes;
      blank = false;
      continue;
    }
    if (inQuotes) {
      blank = false;
      continue;
    }
    if (character === "\n") {
      if (!blank) {
        terminated.push(count);
        if (terminated.length >= MAX_SAMPLED_RECORDS) return { terminated, trailing: null };
      }
      count = 0;
      blank = true;
      continue;
    }
    if (character === delimiter) {
      count += 1;
      blank = false;
      continue;
    }
    if (character !== " " && character !== "\t" && character !== "\r") blank = false;
  }

  return { terminated, trailing: blank ? null : count };
}

function delimiterProfile(
  text: string,
  delimiter: string,
  complete: boolean,
): { consistent: boolean; single: boolean } {
  const scan = scanDelimiter(text, delimiter);
  const records = [...scan.terminated];
  // An unterminated trailing record is only trustworthy once the stream ended;
  // otherwise the prefix cut it in half and its count means nothing.
  if (complete && scan.trailing !== null) records.push(scan.trailing);

  const first = records[0];
  if (first === undefined || first < 1) return { consistent: false, single: false };
  const uniform = records.every((count) => count === first);
  return { consistent: uniform && records.length >= 2, single: uniform && records.length === 1 };
}

const MARKDOWN_SIGNALS: readonly RegExp[] = [
  /^ {0,3}#{1,6}[ \t]\S/m, // ATX heading
  /^ {0,3}[-*+][ \t]+\S/m, // bullet list
  /^ {0,3}\d{1,9}[.)][ \t]+\S/m, // ordered list
  /^ {0,3}>[ \t]?\S/m, // block quote
  /^ {0,3}(?:```|~~~)/m, // fenced code
  /^ {0,3}\|[^\n]*\|[ \t]*$/m, // table row
  /\[[^\]\n]{1,200}\]\([^\s)\n]{1,500}\)/, // inline link
];

/**
 * Markdown is plain text with conventions, so there is no decisive content
 * signal — two independent structures are required on content alone. A
 * `.md` label agrees with a single structure, which is the only weight it
 * carries here.
 */
function looksLikeMarkdown(text: string, extension: string | null): boolean {
  const labelled =
    extension === "md" ||
    extension === "markdown" ||
    extension === "mdown" ||
    extension === "mkd";
  let signals = 0;
  for (const pattern of MARKDOWN_SIGNALS) {
    if (pattern.test(text)) signals += 1;
    if (signals >= 2) return true;
  }
  return signals >= 1 && labelled;
}

type JsonScanResult = "complete" | "prefix" | "invalid";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * Tolerant, iterative JSON scanner over a bounded prefix. It answers one
 * question — "could this text be the beginning of a single JSON document?" —
 * and is only reached for bodies too large to have been retained whole.
 *
 * There is no recursion (an explicit stack), no backtracking, and the input is
 * capped at `UPLOAD_SNIFF_PREFIX_CHARS` characters of already-validated UTF-8.
 */
function scanJsonPrefix(text: string): JsonScanResult {
  const stack: string[] = [];
  let expect: "value" | "key" | "colon" | "separator" = "value";
  let closable = false; // an as-yet-empty container may close here
  let finished = false; // a whole document has been read
  let index = 0;

  while (index < text.length) {
    const character = text.charAt(index);
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (finished) return "invalid"; // trailing content after the document
    const top = stack[stack.length - 1];

    if (expect === "value") {
      if (character === "{") {
        stack.push("{");
        expect = "key";
        closable = true;
        index += 1;
        continue;
      }
      if (character === "[") {
        stack.push("[");
        expect = "value";
        closable = true;
        index += 1;
        continue;
      }
      if (closable && character === "]" && top === "[") {
        stack.pop();
        expect = "separator";
        closable = false;
        finished = stack.length === 0;
        index += 1;
        continue;
      }
      const scalar = readScalar(text, index);
      if (scalar === "invalid") return "invalid";
      if (scalar === "truncated") return "prefix";
      index = scalar;
      expect = "separator";
      closable = false;
      finished = stack.length === 0;
      continue;
    }

    if (expect === "key") {
      if (closable && character === "}" && top === "{") {
        stack.pop();
        expect = "separator";
        closable = false;
        finished = stack.length === 0;
        index += 1;
        continue;
      }
      if (character !== '"') return "invalid";
      const key = readString(text, index);
      if (key === "invalid") return "invalid";
      if (key === "truncated") return "prefix";
      index = key;
      expect = "colon";
      closable = false;
      continue;
    }

    if (expect === "colon") {
      if (character !== ":") return "invalid";
      index += 1;
      expect = "value";
      closable = false;
      continue;
    }

    // expect === "separator"
    if (character === "," && top !== undefined) {
      expect = top === "{" ? "key" : "value";
      closable = false;
      index += 1;
      continue;
    }
    if ((character === "}" && top === "{") || (character === "]" && top === "[")) {
      stack.pop();
      expect = "separator";
      closable = false;
      finished = stack.length === 0;
      index += 1;
      continue;
    }
    return "invalid";
  }

  return finished ? "complete" : "prefix";
}

/** Index just past the scalar starting at `start`. */
function readScalar(text: string, start: number): number | "truncated" | "invalid" {
  const character = text.charAt(start);
  if (character === '"') return readString(text, start);

  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, start)) return start + literal.length;
    if (start + literal.length > text.length && literal.startsWith(text.slice(start))) {
      return "truncated";
    }
  }

  if (character === "-" || (character >= "0" && character <= "9")) {
    let end = start;
    while (end < text.length && isNumberCharacter(text.charAt(end))) end += 1;
    // A number running to the end of the prefix may continue past it.
    if (end >= text.length) return "truncated";
    return JSON_NUMBER.test(text.slice(start, end)) ? end : "invalid";
  }

  return "invalid";
}

function isNumberCharacter(character: string): boolean {
  return (
    (character >= "0" && character <= "9") ||
    character === "-" ||
    character === "+" ||
    character === "." ||
    character === "e" ||
    character === "E"
  );
}

/** Index just past the closing quote of the string starting at `start`. */
function readString(text: string, start: number): number | "truncated" | "invalid" {
  let index = start + 1;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === "\\") {
      if (index + 1 >= text.length) return "truncated";
      const escape = text.charAt(index + 1);
      if (!JSON_ESCAPES.has(escape)) return "invalid";
      if (escape === "u") {
        if (index + 6 > text.length) return "truncated";
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) return "invalid";
        index += 6;
        continue;
      }
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  return "truncated";
}
