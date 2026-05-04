/**
 * Google Provider — Protobuf Encoder/Decoder + v2 Builders
 *
 * Provides protobuf serialization/deserialization utilities and
 * v2-specific request/response builders for the Cloud Speech v2 API.
 *
 * Exports to window.__GP.pb for use by webchannel.js.
 */
(function () {
    'use strict';

    window.__GP = window.__GP || {};

    // =========================================================================
    // Protobuf Encoder / Decoder Helpers (used by v2 backend)
    // Wire types: 0=varint, 2=length-delimited, 5=32-bit
    // =========================================================================

    // Encodes a number into a Protobuf varint (variable-length integer).
    function pbEncodeVarint(value) {
        const bytes = [];
        value = value >>> 0; // force unsigned 32-bit
        while (value > 0x7f) {
            bytes.push((value & 0x7f) | 0x80);
            value >>>= 7;
        }
        bytes.push(value & 0x7f);
        return new Uint8Array(bytes);
    }

    // Encodes a Protobuf field tag (combines field number and wire type).
    function pbEncodeTag(fieldNum, wireType) {
        return pbEncodeVarint((fieldNum << 3) | wireType);
    }

    // Concatenates multiple Uint8Arrays together into a single Uint8Array.
    function pbConcat(...arrays) {
        const totalLen = arrays.reduce((s, a) => s + a.length, 0);
        const result = new Uint8Array(totalLen);
        let offset = 0;
        for (const arr of arrays) {
            result.set(arr, offset);
            offset += arr.length;
        }
        return result;
    }

    // Encodes a string into a length-delimited Protobuf field.
    function pbEncodeStringField(fieldNum, str) {
        const encoded = new TextEncoder().encode(str);
        return pbConcat(pbEncodeTag(fieldNum, 2), pbEncodeVarint(encoded.length), encoded);
    }

    // Encodes raw bytes into a length-delimited Protobuf field.
    function pbEncodeBytesField(fieldNum, bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return pbConcat(pbEncodeTag(fieldNum, 2), pbEncodeVarint(data.length), data);
    }

    // Encodes a varint into a Protobuf field (fieldNum + wireType 0).
    function pbEncodeVarintField(fieldNum, value) {
        return pbConcat(pbEncodeTag(fieldNum, 0), pbEncodeVarint(value));
    }

    // Encodes a nested Protobuf message into a length-delimited field.
    function pbEncodeMessageField(fieldNum, submessageBytes) {
        return pbConcat(pbEncodeTag(fieldNum, 2), pbEncodeVarint(submessageBytes.length), submessageBytes);
    }

    // --- Protobuf Decoder ---

    // Decodes a raw Protobuf buffer into a dictionary of field numbers to arrays of values.
    function pbDecode(buffer) {
        const view = new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || buffer.length);
        const fields = {};
        let pos = 0;

        function readVarint() {
            let result = 0, shift = 0;
            while (pos < view.byteLength) {
                const b = view.getUint8(pos++);
                result |= (b & 0x7f) << shift;
                if (!(b & 0x80)) return result >>> 0;
                shift += 7;
            }
            return result >>> 0;
        }

        while (pos < view.byteLength) {
            const tag = readVarint();
            const fieldNum = tag >>> 3;
            const wireType = tag & 0x07;

            let value;
            if (wireType === 0) {
                value = readVarint();
            } else if (wireType === 2) {
                const len = readVarint();
                value = new Uint8Array(view.buffer, view.byteOffset + pos, len);
                pos += len;
            } else if (wireType === 5) {
                value = view.getFloat32(pos, true);
                pos += 4;
            } else if (wireType === 1) {
                value = view.getFloat64(pos, true);
                pos += 8;
            } else {
                break; // unknown wire type
            }

            if (!fields[fieldNum]) fields[fieldNum] = [];
            fields[fieldNum].push(value);
        }
        return fields;
    }

    function pbDecodeString(bytes) {
        return new TextDecoder().decode(bytes);
    }

    // =========================================================================
    // V2 Config & Audio Builders (v2 backend)
    // =========================================================================

    // Builds the initial StreamingRecognizeRequest protobuf payload containing the recognition configuration.
    function buildStreamingConfigProto(lang, interimResults) {
        const langCode = lang || "en-US";

        const langInner = pbEncodeStringField(1, langCode);
        const langWrapper = pbEncodeMessageField(2, langInner);
        const field293000 = pbEncodeMessageField(293000, langWrapper);

        const audioConfig = pbConcat(
            pbEncodeTag(2, 5), new Uint8Array(new Float32Array([16000.0]).buffer),
            pbEncodeVarintField(3, 11),
            pbEncodeVarintField(4, 1)
        );
        const field293100 = pbEncodeMessageField(293100, audioConfig);

        const clientId = pbEncodeStringField(2, "bard-web-frontend");
        const field294000 = pbEncodeMessageField(294000, clientId);

        const recogConfig = pbConcat(
            pbEncodeMessageField(1, pbEncodeStringField(10, langCode)),
            pbEncodeVarintField(5, 1),
            pbEncodeVarintField(40, 1),
            pbEncodeVarintField(52, 1)
        );
        const field294500 = pbEncodeMessageField(294500, recogConfig);

        return pbConcat(
            pbEncodeStringField(1, "intelligent-dictation"),
            pbEncodeVarintField(2, 1),
            field293000,
            field293100,
            field294000,
            field294500
        );
    }

    // Builds a StreamingRecognizeRequest protobuf payload containing a chunk of audio.
    function buildAudioChunkProto(audioBytes) {
        const inner = pbEncodeBytesField(1, audioBytes);
        return pbEncodeMessageField(293101, inner);
    }

    // Decodes the StreamingRecognizeResponse protobuf received from the Cloud Speech v2 server.
    function decodeStreamingResponse(bytes) {
        const resp = pbDecode(bytes);
        const result = { results: [], speechEventType: 0 };
        if (resp[5]) result.speechEventType = resp[5][0];
        if (resp[1253625]) {
            for (const cBytes of resp[1253625]) {
                if (!(cBytes instanceof Uint8Array)) continue;
                const c = pbDecode(cBytes);
                let lang = "";
                if (c[4] && c[4][0] instanceof Uint8Array) lang = pbDecodeString(c[4][0]);
                else if (c[3] && c[3][0] instanceof Uint8Array) lang = pbDecodeString(c[3][0]);
                if (c[1]) {
                    for (const eBytes of c[1]) {
                        if (!(eBytes instanceof Uint8Array)) continue;
                        const e = pbDecode(eBytes);
                        const pr = { alternatives: [], isFinal: e[1] && e[1][0] === 1, stability: e[2] ? e[2][0] : 0, languageCode: lang };
                        if (e[4] || e[3]) {
                            for (const aBytes of (e[4] || e[3])) {
                                if (!(aBytes instanceof Uint8Array)) continue;
                                const a = pbDecode(aBytes);
                                if (a[1]) {
                                    for (const sBytes of a[1]) {
                                        if (!(sBytes instanceof Uint8Array)) continue;
                                        const s = pbDecode(sBytes);
                                        if (s[1] && s[1][0] instanceof Uint8Array) {
                                            pr.alternatives.push({ transcript: pbDecodeString(s[1][0]), confidence: s[2] ? s[2][0] : 0.9 });
                                        }
                                    }
                                }
                            }
                        }
                        if (pr.alternatives.length > 0) result.results.push(pr);
                    }
                }
            }
        }
        return result;
    }

    function uint8ToBase64(bytes) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return btoa(binary);
    }

    // Export to shared namespace
    window.__GP.pb = {
        encodeVarint: pbEncodeVarint,
        encodeTag: pbEncodeTag,
        concat: pbConcat,
        encodeStringField: pbEncodeStringField,
        encodeBytesField: pbEncodeBytesField,
        encodeVarintField: pbEncodeVarintField,
        encodeMessageField: pbEncodeMessageField,
        decode: pbDecode,
        decodeString: pbDecodeString,
        buildStreamingConfigProto,
        buildAudioChunkProto,
        decodeStreamingResponse,
        uint8ToBase64
    };
})();
