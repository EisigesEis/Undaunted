#pragma once

#include <cstdint>
#include <string>

namespace AssetOptimization { struct Metrics; }

namespace ServerPerformance {
    void Configure(bool enabled, uint32_t intervalSeconds, const std::string& serverId,
        const std::string& mapPath, const std::wstring& outputDirectory,
        uint64_t maximumFileBytes);
    bool Start(const AssetOptimization::Metrics& optimization);
    void Stop();
    std::string StatusJson();
    void RecordEngineTick(float deltaSeconds, double originalTickMilliseconds);
    void RecordNetworking(double milliseconds);
    void RecordProcessEvent(bool netServerCandidate, bool originalCall);
    void RecordProcessEventNameLookup(bool usedFallback);
    void RecordProcessEventFunctionMatch();
    void RecordAbilityRpc(bool activated, bool usedOriginalFallback);
    std::string JsonString(const std::string& value);
    void RecordLifecycleEvent(const std::string& eventName, const std::string& fieldsJson = "");
    void Tick();
}
