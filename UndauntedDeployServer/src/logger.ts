import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync
} from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";

import pino, { type DestinationStream, type Logger, type StreamEntry } from "pino";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MINIMUM_MAX_BYTES = 1024 * 1024;
const MAXIMUM_MAX_BYTES = 1024 * 1024 * 1024;

class BoundedFileDestination extends Writable {
  readonly path: string;
  private readonly descriptor: number;
  private bytesWritten = 0;
  private destinationClosed = false;

  constructor(directory: string, maximumBytes: number){
    super();
    mkdirSync(directory, {recursive: true});
    this.path = resolve(directory, "deployserver.log");
    this.descriptor = openSync(this.path, "w");
    this.maximumBytes = maximumBytes;
  }

  private readonly maximumBytes: number;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void){
    try{
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      if(this.bytesWritten + buffer.byteLength <= this.maximumBytes){
        this.bytesWritten += writeSync(this.descriptor, buffer);
      }
      callback();
    }
    catch(error){
      callback(error as Error);
    }
  }

  close(){
    if(this.destinationClosed){
      return;
    }

    this.destinationClosed = true;
    closeSync(this.descriptor);
  }
}

function ParseMaximumBytes(value: string | undefined){
  const parsed = Number(value);
  if(!Number.isSafeInteger(parsed) || parsed < MINIMUM_MAX_BYTES || parsed > MAXIMUM_MAX_BYTES){
    return DEFAULT_MAX_BYTES;
  }

  return parsed;
}

export type LoggingInstance = {
  logger: Logger,
  fileDiagnosticsEnabled: boolean,
  diagnosticsPath: string | undefined,
  close: () => void
};

export function CreateLogging(
  environment: NodeJS.ProcessEnv = process.env,
  consoleStream: DestinationStream = pino.destination(1)
): LoggingInstance {
  const logLevel = environment.LOG_LEVEL || "info";
  const fileDiagnosticsRequested = environment.DEPLOYSERVER_FILE_DIAGNOSTICS === "true";
  const diagnosticsDirectory = environment.DEPLOYSERVER_DIAGNOSTICS_DIRECTORY?.trim();
  let fileDestination: BoundedFileDestination | undefined;

  if(fileDiagnosticsRequested && diagnosticsDirectory){
    try{
      fileDestination = new BoundedFileDestination(
        resolve(diagnosticsDirectory),
        ParseMaximumBytes(environment.DEPLOYSERVER_DIAGNOSTICS_MAX_BYTES)
      );
    }
    catch{
      // Diagnostics must fail closed: console logging remains available, but a
      // bad optional output path must never prevent the server from starting.
      fileDestination = undefined;
    }
  }

  const streams: StreamEntry[] = [{stream: consoleStream}];
  if(fileDestination){
    streams.push({stream: fileDestination});
  }

  const instance = pino({level: logLevel}, pino.multistream(streams));
  let closed = false;

  return {
    logger: instance,
    fileDiagnosticsEnabled: fileDestination != undefined,
    diagnosticsPath: fileDestination?.path,
    close: () => {
      if(closed){
        return;
      }
      closed = true;
      instance.flush();
      fileDestination?.close();
    }
  };
}

export const logging = CreateLogging();
export const logger = logging.logger;

process.once("beforeExit", logging.close);
