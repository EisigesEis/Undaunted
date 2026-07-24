#pragma once

#include <cstdint>
#include <string>

namespace AssetOptimization {
    enum class Mode {
        Off,
        Report,
        Safe,
        Aggressive
    };

    enum class SafetyGate {
        NotRequired,
        Passed,
        InitialLoad,
        ConnectionsPresent,
        Timeout,
        SignatureMismatch,
        Failed
    };

    struct Metrics {
        Mode mode = Mode::Off;
        SafetyGate safetyGate = SafetyGate::NotRequired;
        bool signatureValid = false;
        bool profilingEnabled = false;
        bool failed = false;
        uint64_t objectCountBefore = 0;
        uint64_t objectCountAfter = 0;
        uint64_t candidates = 0;
        uint64_t collected = 0;
        uint64_t retained = 0;
        uint64_t textures = 0;
        uint64_t materials = 0;
        uint64_t sounds = 0;
        uint64_t mapPackageCandidates = 0;
        uint64_t activeMapPackages = 0;
        uint64_t inactiveMapPackages = 0;
        uint64_t durationMs = 0;
        uint64_t workingSetBefore = 0;
        uint64_t workingSetAfter = 0;
        uint64_t privateBytesBefore = 0;
        uint64_t privateBytesAfter = 0;
        uint64_t configuredMaxFps = 30;
        double observedMaxFps = 0.0;
        bool capSignatureValid = false;
        bool capResolved = false;
        bool capApplied = false;
        bool capVerified = false;
        uint64_t preReadyNetworkingPasses = 0;
        uint64_t netServerMaxTickRate = 0;
        uint64_t maxNetTickRate = 0;
        uint64_t bootstrapMinimumMilliseconds = 3000;
        uint64_t bootstrapMaximumMilliseconds = 5000;
        uint64_t considerCacheMaxAgeMilliseconds = 250;
        bool manifestWritten = false;
        std::string manifestPath;
        std::string expectedGcSignature;
        std::string observedGcSignature;
        std::string error;
    };

    Mode ParseMode(const std::wstring& value);
    const char* ModeName(Mode mode);
    const char* SafetyGateName(SafetyGate gate);
    bool IsInitialLoadComplete();
    Metrics MakeSkipped(Mode mode, SafetyGate gate, const std::string& reason);
    Metrics Run(Mode mode, bool stripInactiveMapPackages, bool logDetails, const std::string& mapContext);
    std::string MetricsJson(const Metrics& metrics);
}
