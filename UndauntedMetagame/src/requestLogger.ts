import express from "express";
import { logger } from "./logger";

export function LogFullAttempt(req: express.Request, message = "Unstubbed route full request", parseError?: unknown) {
    const { authorization: _Authorization, ...SafeHeaders } = req.headers;
    logger.warn({
        method: req.method,
        url: req.url,
        originalUrl: req.originalUrl,
        baseUrl: req.baseUrl,
        path: req.path,
        httpVersion: req.httpVersion,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        headers: SafeHeaders,
        query: req.query,
        params: req.params,
        body: req.body,
        parseError: parseError instanceof Error ? parseError.message : parseError
    }, message);
}
