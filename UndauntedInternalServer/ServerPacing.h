#pragma once

#include <cstddef>
#include <cstdint>

namespace ServerPacing {
    constexpr std::size_t EvidenceWindowSize = 128;
    constexpr std::size_t HistogramBucketCount = 16;

    // The final bucket contains values greater than the last finite boundary.
    inline constexpr double MillisecondHistogramUpperBounds[HistogramBucketCount - 1] = {
        0.05, 0.10, 0.25, 0.50, 1.0, 2.0, 4.0, 8.0,
        12.0, 16.0, 24.0, 32.0, 40.0, 50.0, 100.0
    };

    enum class CorrectionState : uint32_t {
        Disabled,
        Observing,
        Active,
        Fallback
    };

    enum class InstallFailure : uint32_t {
        None,
        NotDedicatedServer,
        InvalidExecutable,
        ExecutableBuildMismatch,
        SignatureMismatch,
        MinHookCreateFailed,
        MinHookEnableFailed
    };

    enum class FallbackReason : uint32_t {
        None,
        TimerApiUnavailable,
        TimerCreateFailed,
        TimerSetFailed,
        TimerWaitTimedOut,
        TimerWaitFailed,
        UnimprovedCadence,
        ExcessiveFineSpin
    };

    enum class GuardReductionFallbackReason : uint32_t {
        None,
        NativeOvershoot,
        CadenceRegression,
        NoFineWaitImprovement
    };

    struct FrameObservation {
        // These are deliberately supplied by the caller so this module does not
        // depend on Unreal SDK types or perform console-variable lookups.
        double cvarMaxFps = 0.0;
        double cachedMaxFps = 0.0;
        double virtualMaxFps = 0.0;
        double engineWorkMilliseconds = 0.0;
        double frameGapMilliseconds = 0.0;
        bool fixedFrameRate = false;
    };

    struct WaitCounters {
        uint64_t calls = 0;
        uint64_t measuredCalls = 0;
        uint64_t requestedNanoseconds = 0;
        uint64_t actualNanoseconds = 0;
        uint64_t maximumActualNanoseconds = 0;
    };

    struct HistogramSnapshot {
        uint64_t buckets[HistogramBucketCount]{};
        uint64_t count = 0;
        double totalMilliseconds = 0.0;
        double minimumMilliseconds = 0.0;
        double maximumMilliseconds = 0.0;
    };

    // Trivially-copyable snapshot suitable for the fixed-size profiling path.
    struct Snapshot {
        CorrectionState state = CorrectionState::Disabled;
        InstallFailure installFailure = InstallFailure::None;
        FallbackReason fallbackReason = FallbackReason::None;
        int32_t minHookStatus = 0;

        bool installAttempted = false;
        bool executableBuildValid = false;
        bool signaturesValid = false;
        bool hookCreated = false;
        bool hookEnabled = false;
        bool highResolutionApiAvailable = false;
        bool timerCreated = false;
        bool correctionEverActivated = false;
        bool guardReductionActive = false;
        bool guardReductionEverActivated = false;
        bool guardReductionPermanentlyDisabled = false;
        GuardReductionFallbackReason guardReductionFallbackReason =
            GuardReductionFallbackReason::None;

        uint64_t observedFrames = 0;
        uint64_t evaluatedWindows = 0;
        uint64_t qualifiedWindows = 0;
        uint64_t activeWindows = 0;
        uint64_t consecutiveUnimprovedWindows = 0;
        uint64_t timerFailures = 0;
        uint64_t guardReductionWindows = 0;
        uint64_t guardReductionBadWindows = 0;
        uint64_t guardReductionAppliedCalls = 0;
        uint64_t guardReductionAppliedNanoseconds = 0;

        double cvarMaxFps = 0.0;
        double cachedMaxFps = 0.0;
        double virtualMaxFps = 0.0;
        double nativePacingWaitMilliseconds = 0.0;
        double nativePacingOvershootMilliseconds = 0.0;
        double nativeDeltaMilliseconds = 0.0;
        double rollingMedianCadenceHz = 0.0;
        double rollingP95EngineWorkMilliseconds = 0.0;
        double rollingMedianCoarseOvershootMilliseconds = 0.0;
        double rollingP95FineSpinMilliseconds = 0.0;
        double rollingP95NativeOvershootMilliseconds = 0.0;
        double guardReductionBaselineFineSpinMilliseconds = 0.0;
        double overshootEwmaMilliseconds = 0.0;
        double cadenceDriftEwmaHz = 0.0;
        uint32_t guardReductionCooldownWindows = 0;

        WaitCounters coarseWait{};
        WaitCounters yieldWait{};
        WaitCounters otherWait{};
        WaitCounters correctedWait{};
        WaitCounters guardExtendedWait{};

        HistogramSnapshot nativePacingWaitHistogram{};
        HistogramSnapshot nativePacingOvershootHistogram{};
        HistogramSnapshot nativeDeltaHistogram{};
        HistogramSnapshot engineWorkHistogram{};
        HistogramSnapshot frameGapHistogram{};
    };

    // MinHook must already be initialized. This function only creates and
    // enables the single, signature-checked dedicated-server detour.
    bool Install(uintptr_t executableBase, bool dedicatedServer);

    // Call once after each original UGameEngine::Tick. Native wait/delta values
    // are read from build-validated engine globals by this module.
    void ObserveFrame(const FrameObservation& observation);

    Snapshot GetSnapshot();
    const char* CorrectionStateName(CorrectionState state);
    const char* InstallFailureName(InstallFailure failure);
    const char* FallbackReasonName(FallbackReason reason);
    const char* GuardReductionFallbackReasonName(GuardReductionFallbackReason reason);
    void Shutdown();
}
