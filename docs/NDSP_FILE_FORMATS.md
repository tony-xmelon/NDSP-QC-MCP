# Quad Cortex file-format findings

This note records formats that were verified against Cortex Control 4.1.0,
CorOS 4.1.0 protocol descriptors, public device samples, and two local backups
created from the connected Quad Cortex on 2026-08-31.

## Native preset files

- Device preset files use the `.pb` extension.
- Their payload is a Protocol Buffers `BinaryPreset` message.
- A public `Vienna.pb` sample decodes with the current pyquadcortex
  `BinaryPreset` descriptor and reserializes byte-for-byte without loss.
- `BinaryPreset` contains the preset metadata, tempo and scenes, four chains,
  models and parameters, routing and split control points, bypass state, MIDI
  messages, and stomp assignments.
- Setlists are XML indexes whose preset entries contain a hash and an absolute
  device path ending in `.pb`.

Compatibility rule: preserve the original protobuf bytes whenever possible.
Parsing and rebuilding only the known fields could discard fields introduced by
newer firmware.

## Cortex Control 4.1.0 local backups

The portable backup is a JSON document. Cortex Control also creates an internal
metadata sidecar:

```text
Backups/Local backup N.json
Backups/Metadata/Local backup N_meta.json
```

The main JSON object has these fields:

```text
author
author_id
compatibility
created
creator
creator_version
name
payload
payload_hash
type
```

Observed values include `type: "backup"`, `creator: "quad"`, and
`creator_version: "4.1.0"`. The `compatibility` array identifies supported
targets. Personal author identifiers are deliberately omitted from this note.

`payload` is Base64 text. Decoding it produces a high-entropy binary container,
not raw JSON, protobuf, ZIP, gzip, zlib, raw DEFLATE, bzip2, LZMA, tar, or a
plain Cortex preset. Two backups of unchanged device state had:

- the same four-byte binary prefix;
- different lengths and different `payload_hash` values;
- approximately 8 bits/byte entropy;
- no meaningful printable strings; and
- no direct SHA-256 match between `payload_hash` and either the Base64 text or
  the decoded bytes.

This is consistent with a device-produced protected/compressed container with a
small fixed header. Its inner encoding and the exact `payload_hash` derivation
remain intentionally undocumented by Neural DSP and should not be guessed.
The complete JSON can nevertheless be exported, imported, and restored without
opening the inner payload, which is how QC Control should preserve compatibility.

The `_meta.json` sidecar currently contains:

```json
{"id":"<same value as payload_hash>","downloadTime":""}
```

The Cortex Control import chooser accepts main `.json` backup documents and
explicitly excludes `_meta.json`; therefore the sidecar is local catalog state,
not part of the portable backup.

The 4.1.0 installation on this machine stored the files below
`%APPDATA%\Neural DSP\Cortex Control\Backups`. The official manual currently
documents a slightly different Windows path, so QC Control must not depend on a
hard-coded Cortex Control directory.

## Device backup protocol

Current CorOS protocol descriptors expose these message families:

- `LocalBackup` (message type 40)
- `CloudBackup` (message type 41)
- `BackupsForward` (message type 30)

`LocalBackupMessage` carries `action`, `request_id`, chunked `backup_json`,
`can_apply_backup`, `applied_backup`, and `is_last_chunk`. The generic action
enum includes `CREATE`, `UPDATE`, `READ`, `UPLOAD`, and `DOWNLOAD`.

`BackupsForward` supports create/update, download, rename, delete, list,
fetch-URL, and upload-status operations for Cortex Cloud forwarding. This means
standalone backup support can be implemented directly over the Quad Cortex USB
protocol; QC Control does not need or use Cortex Control at runtime.

This direct path was verified against the connected Quad Cortex. A native
`CREATE` request returned 12 ordered JSON chunks (11 full chunks and one final
chunk), and their concatenation validated as the same current backup wrapper.

An older pre-CorOS-3 OpenCortex reference reports the device-side artifact as
`/media/p4/downloaded_backup.tar.gz`. That is useful historical evidence for an
inner archive, but it must not be treated as the current Cortex Control 4.1.0
PC interchange format, which is the JSON wrapper described above.

## Cortex Cloud downloads

The current Cortex Cloud web client does not download a preset file into the
browser. It records a product in the user's download queue; the Quad Cortex then
retrieves it and places it in the device's Downloads setlist/library. The mobile
app follows the same user-visible workflow documented by Neural DSP.

There is therefore no separate public "Cortex Cloud preset file" extension. The
current stack uses three distinct layers:

1. the native preset stored by the Quad Cortex is a `BinaryPreset` `.pb`;
2. the Cloud product record is JSON metadata plus an opaque `payload` and
   `payload_hash`; and
3. the HTTP API packages product transfer as multipart `productFile`, using the
   internal filename `file.zip` and JSON/ZIP media types.

Static inspection of Cortex Control 4.1.0 confirms the product endpoint and
field vocabulary together: `user/products/`, `products/exists?`, `author_id`,
`compatibility`, `creator`, `creator_version`, `updated`, `created`, `tags`,
`payload`, `description`, `payload_hash`, `author_username`, `type`, and `name`.
It also contains the exact multipart tuple `productFile`, `file.zip`, and
`application/json`, plus the ZIP download tuple `productFile`, `file.zip`, and
`application/zip`.

A live upload of an existing preset was captured from Cortex Control 4.1.0 on
2026-08-31. After the official overwrite confirmation, the host sent:

- `ConfirmationMessage { confirmation_id: 8, response: OK }`; then
- one `ProductForward` logical HID message.

The `ProductForward` body was 106 high-entropy bytes and did not parse as the
public `ProductForwardMessage` protobuf, despite a valid HID envelope and valid
message-type trailer. Normal `KeepAlive` messages from the same capture decoded
correctly, ruling out a framing error. The Cloud-forward payload is therefore
protected/opaque at this layer. The public descriptor documents the cleartext
shape (`operation`, `url`, `timeout`, `is_multipart`, repeated `headers`, and a
byte `payload`), but not the codec that protects the live body.

This is transport packaging and a private service protocol, not a stable file
format that QC Control should manufacture or depend on. Native device presets
remain `.pb`; complete device backups remain the portable JSON wrapper described
above. For a standalone library export, preserve the original `.pb` files and a
separate index rather than relabeling a private Cloud transaction as a file.

## Implementation policy for QC Control

1. Export/import individual presets as untouched `.pb` bytes.
2. Export a library as an index plus untouched `.pb` files only after all raw
   device files have been read successfully.
3. Create `Device Backup` by collecting the complete chunked `backup_json` from
   the Quad Cortex and writing the native main JSON unchanged.
4. Validate `type`, required fields, Base64 syntax, size limits, and firmware
   compatibility before offering restore.
5. Treat restore as destructive: preview metadata and require final confirmation.
6. Never require Cortex Control, its installation folder, account tokens, or
   private cache directories at runtime.

## References

- Neural DSP Quad Cortex Manual 4.1.0: <https://neuraldsp.com/manual/quad-cortex>
- Public `BinaryPreset` schema: <https://raw.githubusercontent.com/VanIseghemThomas/OpenCortex/main/desktop_editor/public/protos/Preset.proto>
- Public setlist example: <https://raw.githubusercontent.com/VanIseghemThomas/OpenCortex/main/desktop_editor/public/setlist_example.xml>
- OpenCortex device-file research: <https://github.com/VanIseghemThomas/OpenCortex>
- pyquadcortex protocol implementation: <https://github.com/stokes-audio/pyquadcortex>
