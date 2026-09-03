import assert from "node:assert/strict";
import test from "node:test";

import { UPLOAD_ALLOWED_CONTENT_TYPES } from "@agent-harness/contracts";

import { ApiHttpError } from "../http.js";
import {
  UPLOAD_SNIFF_PREFIX_CHARS,
  UploadSniffer,
  isAllowedUploadContentType,
  sniffUploadContentType,
} from "./sniff.js";

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

/** Runs `act`, asserting it threw the expected `ApiHttpError`, and returns it. */
function rejected(act: () => unknown, status: number, code: string): ApiHttpError {
  let caught: unknown;
  try {
    act();
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof ApiHttpError)) {
    assert.fail(`expected ApiHttpError, received ${String(caught)}`);
  }
  assert.equal(caught.statusCode, status);
  assert.equal(caught.code, code);
  return caught;
}

test("rejects a NUL byte anywhere in the stream", () => {
  const sniffer = new UploadSniffer({ filename: "ledger.csv" });
  // Past the retained classification prefix: validation covers every byte.
  sniffer.update(utf8("a".repeat(UPLOAD_SNIFF_PREFIX_CHARS)));

  const error = rejected(
    () => sniffer.update(bytes(0x00)),
    415,
    "unsupported_upload_type",
  );
  assert.match(error.message, /NUL byte at offset 4096/);

  // The rejection sticks: finalize cannot salvage a classification.
  rejected(() => sniffer.finalize(), 415, "unsupported_upload_type");
});

test("rejects a lone surrogate", () => {
  // U+D800 has no legal UTF-8 form; WTF-8 `ED A0 80` is the only way to write it.
  const error = rejected(
    () => sniffUploadContentType(bytes(0x68, 0x69, 0xed, 0xa0, 0x80)),
    415,
    "unsupported_upload_type",
  );
  assert.match(error.message, /not valid UTF-8/);
});

test("rejects a ZIP magic header as an unsupported type", () => {
  // `PK\x03\x04` decodes as valid UTF-8 and contains no NUL, so it is the
  // control-character rule — not a magic-number table — that rejects it.
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...utf8("payload.txt")]);

  const error = rejected(
    () => sniffUploadContentType(zip, { filename: "bundle.zip" }),
    415,
    "unsupported_upload_type",
  );
  assert.match(error.message, /control character at offset 2/);
});

test("rejects the other binary container headers without a magic-number table", () => {
  // §6 rejects the whole archive/binary family at the allow-list. None of these
  // is recognized by signature: each one trips either the control-character
  // rule or the strict decoder, which is the point — there is no format table
  // in this module to carry a parser bug.
  for (const [label, header] of [
    ["gzip", bytes(0x1f, 0x8b, 0x08, 0x00)],
    ["PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["PDF", new Uint8Array([...utf8("%PDF-1.4\n"), 0x25, 0xe2, 0xe3, 0xcf, 0xd3])],
    ["7z", bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)],
    ["tar (ustar header padding)", new Uint8Array([...utf8("archive.txt"), 0x00, 0x00])],
  ] as const) {
    rejected(
      () => sniffUploadContentType(header, { filename: `payload.${label}` }),
      415,
      "unsupported_upload_type",
    );
  }
});

test("rejects invalid UTF-8 that appears mid-stream", () => {
  const sniffer = new UploadSniffer({ filename: "log.txt" });
  // Two chunks of clean text, well past the classification prefix.
  sniffer.update(utf8("clean text line\n".repeat(256)));
  sniffer.update(utf8("clean text line\n".repeat(256)));
  assert.equal(sniffer.bytesSeen, 8192);

  // `C3 28` is a lead byte followed by a non-continuation byte.
  rejected(() => sniffer.update(bytes(0xc3, 0x28)), 415, "unsupported_upload_type");
});

test("rejects a truncated multi-byte sequence at the end of the stream", () => {
  const sniffer = new UploadSniffer();
  sniffer.update(bytes(0x41, 0xe2, 0x82)); // "A" + two thirds of "€"

  const error = rejected(() => sniffer.finalize(), 415, "unsupported_upload_type");
  assert.match(error.message, /ends mid-sequence/);
});

test("accepts a multi-byte sequence split across chunks", () => {
  const tail = utf8("12,50 and prose that is not a table");
  const sniffer = new UploadSniffer({ filename: "prices.txt" });
  sniffer.update(bytes(0xe2, 0x82)); // first two bytes of "€"
  sniffer.update(bytes(0xac)); // its continuation
  sniffer.update(tail);

  assert.equal(sniffer.finalize(), "text/plain");
  assert.equal(sniffer.bytesSeen, 3 + tail.byteLength);
});

test("rejects an empty body", () => {
  rejected(() => new UploadSniffer({ filename: "empty.txt" }).finalize(), 400, "upload_empty");
});

test("classifies CSV from its content", () => {
  const csv = "name,role,team\nada,engineer,core\ngrace,admiral,ops\n";
  assert.equal(sniffUploadContentType(utf8(csv), { filename: "roster.csv" }), "text/csv");
  // No label at all: the delimiter consistency is the whole signal.
  assert.equal(sniffUploadContentType(utf8(csv)), "text/csv");

  // A single record is not consistency, so it needs a label that agrees.
  assert.equal(sniffUploadContentType(utf8("name,role\n")), "text/plain");
  assert.equal(sniffUploadContentType(utf8("name,role\n"), { filename: "h.csv" }), "text/csv");
  assert.equal(sniffUploadContentType(utf8("name,role\n"), { filename: "h.md" }), "text/plain");
});

test("classifies quoted CSV whose fields contain commas and newlines", () => {
  const csv = 'name,note\nada,"analytical, engine"\ngrace,"a note\nspanning lines"\n';
  assert.equal(sniffUploadContentType(utf8(csv)), "text/csv");
});

test("classifies TSV, and uses the label only to break a genuine tie", () => {
  const tsv = "name\trole\nada\tengineer\ngrace\tadmiral\n";
  assert.equal(sniffUploadContentType(utf8(tsv)), "text/tab-separated-values");

  // Both delimiters are consistent here, so the label decides; comma wins by default.
  const ambiguous = "a,b\tc,d\ne,f\tg,h\n";
  assert.equal(sniffUploadContentType(utf8(ambiguous)), "text/csv");
  assert.equal(
    sniffUploadContentType(utf8(ambiguous), { filename: "sheet.tsv" }),
    "text/tab-separated-values",
  );
});

test("classifies JSON, including a document behind a BOM", () => {
  assert.equal(sniffUploadContentType(utf8('{"total":3,"rows":[1,2,3]}')), "application/json");
  assert.equal(sniffUploadContentType(utf8('﻿{"total":3}')), "application/json");
  assert.equal(
    sniffUploadContentType(utf8('[\n  {"id": 1},\n  {"id": 2}\n]\n')),
    "application/json",
  );
});

test("classifies NDJSON, and needs two records unless the label agrees", () => {
  const ndjson = '{"id":1,"ok":true}\n{"id":2,"ok":false}\n';
  assert.equal(sniffUploadContentType(utf8(ndjson)), "application/x-ndjson");

  // One record is indistinguishable from a JSON document on content alone...
  assert.equal(sniffUploadContentType(utf8('{"id":1}\n')), "application/json");
  // ...until the label agrees with it.
  assert.equal(
    sniffUploadContentType(utf8('{"id":1}\n'), { filename: "events.ndjson" }),
    "application/x-ndjson",
  );
});

test("classifies XML with or without a declaration", () => {
  const declared = '<?xml version="1.0" encoding="UTF-8"?>\n<invoices>\n  <invoice id="1"/>\n</invoices>\n';
  assert.equal(sniffUploadContentType(utf8(declared)), "application/xml");
  assert.equal(
    sniffUploadContentType(utf8("<invoices>\n  <invoice id=\"1\"/>\n</invoices>\n")),
    "application/xml",
  );

  // Deliberate, pinned so it is not "fixed" later: HTML lands on
  // `application/xml` rather than gaining a `text/html` branch. `text/html` is
  // not on the allow-list, and v1 never serves these bytes back to a browser —
  // when an endpoint is added it must send `nosniff` and
  // `Content-Disposition: attachment` whatever the stored type says.
  assert.equal(
    sniffUploadContentType(utf8("<!DOCTYPE html>\n<html><body>hi</body></html>\n")),
    "application/xml",
  );
});

test("classifies Markdown from structure, and from the label plus one signal", () => {
  const rich = [
    "# Release notes",
    "",
    "- Ships the upload sniffer",
    "- Rejects binary payloads",
    "",
    "See [the design](https://example.test/design) for details.",
    "",
  ].join("\n");
  // Two independent structures: content alone is enough.
  assert.equal(sniffUploadContentType(utf8(rich)), "text/markdown");

  const thin = "Notes\n\n- just one bullet\n";
  assert.equal(sniffUploadContentType(utf8(thin)), "text/plain");
  assert.equal(sniffUploadContentType(utf8(thin), { filename: "notes.md" }), "text/markdown");
});

test("falls back to text/plain for text with no recognized shape", () => {
  const prose = "just some prose about nothing in particular\nand a second line\n";
  assert.equal(sniffUploadContentType(utf8(prose)), "text/plain");
  // A misleading label cannot promote it.
  assert.equal(sniffUploadContentType(utf8(prose), { filename: "prose.json" }), "text/plain");
});

test("classifies by content when the label disagrees", () => {
  const json = '{"quarter":"Q3","totals":[1,2,3]}';
  assert.equal(sniffUploadContentType(utf8(json), { filename: "totals.csv" }), "application/json");

  const csv = "quarter,total\nQ3,12\nQ4,15\n";
  assert.equal(sniffUploadContentType(utf8(csv), { filename: "totals.json" }), "text/csv");

  // A label that looks like a path is still only a label; the extension is all
  // that is read from it, and the content still decides.
  assert.equal(
    sniffUploadContentType(utf8(csv), { filename: "../../etc/hosts.tsv" }),
    "text/csv",
  );
});

test("classifies a body larger than the retained prefix", () => {
  const rows = Array.from({ length: 400 }, (_, index) => ({ index, label: "row-value-payload" }));
  const json = utf8(JSON.stringify(rows));
  assert.ok(json.byteLength > UPLOAD_SNIFF_PREFIX_CHARS * 2);

  const sniffer = new UploadSniffer({ filename: "rows.txt" });
  for (let offset = 0; offset < json.byteLength; offset += 1024) {
    sniffer.update(json.subarray(offset, offset + 1024));
  }
  assert.equal(sniffer.finalize(), "application/json");
  assert.equal(sniffer.bytesSeen, json.byteLength);

  const ndjson = utf8(rows.map((row) => JSON.stringify(row)).join("\n"));
  assert.ok(ndjson.byteLength > UPLOAD_SNIFF_PREFIX_CHARS);
  assert.equal(sniffUploadContentType(ndjson), "application/x-ndjson");

  const csv = utf8(`index,label\n${rows.map((row) => `${row.index},${row.label}`).join("\n")}\n`);
  assert.ok(csv.byteLength > UPLOAD_SNIFF_PREFIX_CHARS);
  assert.equal(sniffUploadContentType(csv), "text/csv");
});

test("classifies a truncated body from the retained prefix alone", () => {
  // The document closes inside the prefix and prose follows it, so the prefix
  // is not the beginning of one JSON document.
  const closed = `{"note":"x"}\n${"prose that goes on ".repeat(400)}`;
  assert.ok(closed.length > UPLOAD_SNIFF_PREFIX_CHARS);
  assert.equal(sniffUploadContentType(utf8(closed)), "text/plain");

  // Deliberate imprecision, pinned rather than hidden: when the cut lands
  // inside a JSON string the prefix is still a viable document, so a body that
  // turns into prose beyond the prefix is stored as JSON. Both answers are on
  // the allow-list and the agent reads the file as text either way.
  const cutInsideAString = `${JSON.stringify({ note: "x".repeat(UPLOAD_SNIFF_PREFIX_CHARS) })}\nprose\n`;
  assert.equal(sniffUploadContentType(utf8(cutInsideAString)), "application/json");
});

test("keeps the retained prefix whole when an astral character straddles it", () => {
  // The cut at UPLOAD_SNIFF_PREFIX_CHARS lands between the halves of a
  // surrogate pair; the prefix must not end on a dangling half.
  const padded = `a${"\u{1F600}".repeat(3000)}`;
  assert.equal(padded.charCodeAt(UPLOAD_SNIFF_PREFIX_CHARS - 1) >= 0xd800, true);
  assert.equal(sniffUploadContentType(utf8(padded), { filename: "emoji.txt" }), "text/plain");
});

test("finalize is idempotent and update after it is a programmer error", () => {
  const sniffer = new UploadSniffer();
  sniffer.update(utf8("plain enough\n"));
  assert.equal(sniffer.finalize(), "text/plain");
  assert.equal(sniffer.finalize(), "text/plain");
  assert.throws(() => sniffer.update(utf8("more")), /called after finalize/);
});

test("narrows a persisted content type back to the allow-list", () => {
  for (const type of UPLOAD_ALLOWED_CONTENT_TYPES) assert.ok(isAllowedUploadContentType(type));
  assert.equal(isAllowedUploadContentType("application/zip"), false);
  assert.equal(isAllowedUploadContentType("text/html"), false);
  assert.equal(isAllowedUploadContentType(""), false);
});
