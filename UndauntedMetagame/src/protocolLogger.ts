import fs from "node:fs";
import path from "node:path";

type ProtocolName = "stomp" | "xmpp";

export function LogProtocol(protocol: ProtocolName, event: string, data: Record<string, unknown> = {}) {
    if (process.env.PROTOCOL_FILE_LOG === "false") {
        return;
    }

    try {
        const LogDir = process.env.PROTOCOL_LOG_DIR || path.join(process.cwd(), "logs");
        fs.mkdirSync(LogDir, { recursive: true });
        fs.appendFileSync(
            path.join(LogDir, `${protocol}.log`),
            JSON.stringify({
                time: new Date().toISOString(),
                event,
                ...data
            }) + "\n"
        );
    }
    catch {
        // intended skip
    }
}
