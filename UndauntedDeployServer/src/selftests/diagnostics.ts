import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";

import { CreateLogging } from "../logger";

const root = resolve(process.cwd(), `.diagnostics-selftest-${process.pid}`);
const disabledDirectory = resolve(root, "disabled");
const enabledDirectory = resolve(root, "enabled");

rmSync(root, {recursive: true, force: true});
mkdirSync(root, {recursive: true});

try{
  const disabledConsole = new PassThrough();
  let disabledConsoleOutput = "";
  disabledConsole.on("data", (chunk: Buffer) => disabledConsoleOutput += chunk.toString());
  const disabled = CreateLogging({
    NODE_ENV: "production",
    DEPLOYSERVER_DIAGNOSTICS_DIRECTORY: disabledDirectory
  }, disabledConsole);

  disabled.logger.info({event: "disabled-probe"}, "disabled probe");
  disabled.close();
  assert.equal(disabled.fileDiagnosticsEnabled, false);
  assert.equal(existsSync(disabledDirectory), false);
  assert.match(disabledConsoleOutput, /disabled-probe/);

  const enabledConsole = new PassThrough();
  const enabled = CreateLogging({
    NODE_ENV: "production",
    DEPLOYSERVER_FILE_DIAGNOSTICS: "true",
    DEPLOYSERVER_DIAGNOSTICS_DIRECTORY: enabledDirectory,
    DEPLOYSERVER_DIAGNOSTICS_MAX_BYTES: "1048576"
  }, enabledConsole);

  enabled.logger.info({event: "shutdown-flush-probe"}, "shutdown flush probe");
  enabled.close();
  assert.equal(enabled.fileDiagnosticsEnabled, true);
  assert.ok(enabled.diagnosticsPath);
  assert.match(readFileSync(enabled.diagnosticsPath!, "utf8"), /shutdown-flush-probe/);

  console.log("Diagnostics policy self-test passed");
}
finally{
  rmSync(root, {recursive: true, force: true});
}
