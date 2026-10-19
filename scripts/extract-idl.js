// Extracts the Anchor IDL out of the `cargo test __anchor_private_print_idl`
// output and writes it to target/idl/miory.json, the same way `anchor idl
// build` does. Used when the Anchor CLI is not available.
const fs = require("fs");
const path = require("path");

const logPath = process.argv[2];
const outPath = process.argv[3];
const programId = process.argv[4];

const log = fs.readFileSync(logPath, "utf8");

function section(name) {
  const begin = `--- IDL begin ${name} ---`;
  const end = `--- IDL end ${name} ---`;
  const start = log.indexOf(begin);
  const stop = log.indexOf(end);
  if (start === -1 || stop === -1) {
    throw new Error(`section ${name} not found`);
  }
  return log.slice(start + begin.length, stop).trim();
}

const idl = JSON.parse(section("program"));
const address = JSON.parse(section("address"));
const parsedErrors = JSON.parse(section("errors"));
const errorList = Array.isArray(parsedErrors) ? parsedErrors : parsedErrors.errors ?? [];

idl.address = address.address ?? programId;
if (errorList.length > 0) {
  idl.errors = errorList;
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(idl, null, 2));
console.log(
  `IDL written to ${outPath} (address=${idl.address}, errors=${(idl.errors || []).length})`,
);
