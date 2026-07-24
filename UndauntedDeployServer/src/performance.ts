import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { Gameservers } from "./controllers/gameservers";
import { logger } from "./logger";

const ExecFile = promisify(execFile);
const MINIMUM_INTERVAL_SECONDS = 10;
const POWERSHELL_TIMEOUT_MS = 10_000;

type ProcessSnapshot = {
    Id: number,
    CPU: number | null,
    WorkingSet64: number,
    PrivateMemorySize64: number,
    HandleCount: number,
    ThreadCount: number
};

type PreviousCpuSnapshot = {
    cpuSeconds: number,
    sampledAtMs: number
};

const PreviousCpuByPid = new Map<number, PreviousCpuSnapshot>();

function ParseEnabled(Value: string | undefined, Default: boolean){
    if(Value == undefined || Value.trim().length === 0){
        return Default;
    }

    return Value.toLowerCase() === "true";
}

function ParseIntervalSeconds(Name: string, Default: number){
    const Value = Number(process.env[Name]);

    if(!Number.isFinite(Value) || Value < MINIMUM_INTERVAL_SECONDS){
        return Default;
    }

    return Value;
}

function NormalizeSnapshots(Value: unknown): ProcessSnapshot[]{
    if(Value == undefined){
        return [];
    }

    const Candidates = Array.isArray(Value) ? Value : [Value];

    return Candidates.filter((Candidate): Candidate is ProcessSnapshot => {
        if(typeof Candidate !== "object" || Candidate == undefined){
            return false;
        }

        const Snapshot = Candidate as Partial<ProcessSnapshot>;
        return typeof Snapshot.Id === "number"
            && (typeof Snapshot.CPU === "number" || Snapshot.CPU === null)
            && typeof Snapshot.WorkingSet64 === "number"
            && typeof Snapshot.PrivateMemorySize64 === "number"
            && typeof Snapshot.HandleCount === "number"
            && typeof Snapshot.ThreadCount === "number";
    });
}

async function ReadProcessSnapshots(ProcessIds: number[]){
    if(ProcessIds.length === 0){
        return [];
    }

    const IdList = ProcessIds.join(",");
    const Command = `$processes = Get-Process -Id ${IdList} -ErrorAction SilentlyContinue; `
        + `$processes | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64,HandleCount,@{Name='ThreadCount';Expression={$_.Threads.Count}} | ConvertTo-Json -Compress`;
    const {stdout} = await ExecFile("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        Command
    ], {
        windowsHide: true,
        timeout: POWERSHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
    });

    const Output = stdout.trim();
    return Output.length === 0 ? [] : NormalizeSnapshots(JSON.parse(Output));
}

function CalculateCpuPercent(Snapshot: ProcessSnapshot, SampledAtMs: number){
    if(Snapshot.CPU == undefined){
        return undefined;
    }

    const Previous = PreviousCpuByPid.get(Snapshot.Id);
    PreviousCpuByPid.set(Snapshot.Id, {
        cpuSeconds: Snapshot.CPU,
        sampledAtMs: SampledAtMs
    });

    if(Previous == undefined){
        return undefined;
    }

    const ElapsedSeconds = (SampledAtMs - Previous.sampledAtMs) / 1000;
    const CpuSeconds = Snapshot.CPU - Previous.cpuSeconds;

    if(ElapsedSeconds <= 0 || CpuSeconds < 0){
        return undefined;
    }

    return Math.round((CpuSeconds / ElapsedSeconds) * 10_000) / 100;
}

let GameserverSampleInProgress = false;

async function SampleGameservers(){
    if(GameserverSampleInProgress){
        logger.warn("Skipping overlapping gameserver performance sample");
        return;
    }

    GameserverSampleInProgress = true;

    try{
        const TrackedServers = [...Gameservers];
        const TrackedPids = new Set(TrackedServers.map((Server) => Server.processId));

        for(const ProcessId of PreviousCpuByPid.keys()){
            if(!TrackedPids.has(ProcessId)){
                PreviousCpuByPid.delete(ProcessId);
            }
        }

        const SampledAtMs = Date.now();
        const Snapshots = await ReadProcessSnapshots([...TrackedPids]);
        const SnapshotByPid = new Map(Snapshots.map((Snapshot) => [Snapshot.Id, Snapshot]));

        for(const Server of TrackedServers){
            const Snapshot = SnapshotByPid.get(Server.processId);

            if(Snapshot == undefined){
                logger.debug({
                    event: "gameserver-performance-unavailable",
                    serverId: Server.id,
                    processId: Server.processId,
                    port: Server.port
                }, "Tracked gameserver process was unavailable during performance sampling");
                continue;
            }

            logger.info({
                event: "gameserver-performance",
                serverId: Server.id,
                processId: Server.processId,
                port: Server.port,
                map: Server.map,
                origin: Server.origin,
                runtimeSeconds: Math.max(0, Math.round((SampledAtMs - Server.startTime.getTime()) / 1000)),
                expectedPlayerCount: Server.expectedPlayers?.length ?? 0,
                cpuPercentOfOneCore: CalculateCpuPercent(Snapshot, SampledAtMs),
                cumulativeCpuSeconds: Snapshot.CPU,
                workingSetBytes: Snapshot.WorkingSet64,
                privateMemoryBytes: Snapshot.PrivateMemorySize64,
                handleCount: Snapshot.HandleCount,
                threadCount: Snapshot.ThreadCount
            }, "Gameserver performance sample");
        }
    }
    catch(Error){
        logger.warn({err: Error, event: "gameserver-performance-sample-failed"}, "Failed to sample gameserver performance");
    }
    finally{
        GameserverSampleInProgress = false;
    }
}

export function StartPerformanceMonitoring(){
    const GameserverProfilingEnabled = ParseEnabled(process.env.GAMESERVER_PROFILING, false);
    const DeployServerProfilingEnabled = ParseEnabled(process.env.DEPLOYSERVER_PROFILING, false);
    const GameserverIntervalSeconds = ParseIntervalSeconds("GAMESERVER_PROFILE_INTERVAL_SECONDS", 30);
    const DeployServerIntervalSeconds = ParseIntervalSeconds("DEPLOYSERVER_PROFILE_INTERVAL_SECONDS", 60);

    if(DeployServerProfilingEnabled){
        const EventLoopDelay = monitorEventLoopDelay({resolution: 20});
        EventLoopDelay.enable();

        const DeployServerTimer = setInterval(() => {
            const Memory = process.memoryUsage();

            logger.info({
                event: "deployserver-performance",
                processId: process.pid,
                uptimeSeconds: Math.round(process.uptime()),
                residentSetBytes: Memory.rss,
                heapUsedBytes: Memory.heapUsed,
                heapTotalBytes: Memory.heapTotal,
                externalBytes: Memory.external,
                eventLoopDelayMeanMs: Math.round(EventLoopDelay.mean / 1e4) / 100,
                eventLoopDelayP99Ms: Math.round(EventLoopDelay.percentile(99) / 1e4) / 100,
                eventLoopDelayMaxMs: Math.round(EventLoopDelay.max / 1e4) / 100
            }, "DeployServer performance sample");

            EventLoopDelay.reset();
        }, DeployServerIntervalSeconds * 1000);
        DeployServerTimer.unref();
    }

    if(GameserverProfilingEnabled){
        void SampleGameservers();
        const GameserverTimer = setInterval(() => void SampleGameservers(), GameserverIntervalSeconds * 1000);
        GameserverTimer.unref();
    }

    logger.info({
        event: "performance-monitoring-started",
        deployServerProfilingEnabled: DeployServerProfilingEnabled,
        gameserverProfilingEnabled: GameserverProfilingEnabled,
        gameserverIntervalSeconds: GameserverIntervalSeconds,
        deployServerIntervalSeconds: DeployServerIntervalSeconds,
        gameserverMeasurement: "external-process-only"
    }, "Performance monitoring configured");
}
