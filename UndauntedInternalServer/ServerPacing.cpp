#include "ServerPacing.h"

#include <Windows.h>
#include <intrin.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <type_traits>

#include "MinHook/MinHook.h"

namespace ServerPacing {
    namespace {
        constexpr uintptr_t PlatformSleepRva = 0x1D85370;
        constexpr uintptr_t CoarseSleepCallRva = 0x373F044;
        constexpr uintptr_t CoarseSleepReturnRva = 0x373F049;
        constexpr uintptr_t YieldSleepCallRva = 0x373F074;
        constexpr uintptr_t YieldSleepReturnRva = 0x373F079;
        // FUN_14373EDA0 writes double values to each of these globals after
        // completing the native coarse-wait plus QPC/yield pacing loop.
        constexpr uintptr_t NativePacingWaitRva = 0x5E6BCD0;
        constexpr uintptr_t NativePacingOvershootRva = 0x5E6BCD8;
        constexpr uintptr_t NativeDeltaSecondsRva = 0x5971690;

        constexpr uint32_t ExpectedExecutableTimestamp = 0x5F9A37D4;
        constexpr uint32_t ExpectedExecutableImageSize = 0x066CB000;
        constexpr double ExpectedMaxFps = 30.0;
        constexpr double MaxFpsTolerance = 0.5;
        constexpr double ActivationMaximumCadenceHz = 28.0;
        constexpr double ActiveMinimumAcceptedCadenceHz = 29.5;
        constexpr double ActivationMaximumEngineWorkP95Milliseconds = 5.0;
        constexpr double ActivationMinimumOvershootMedianMilliseconds = 2.0;
        constexpr double ExcessiveFineSpinP95Milliseconds = 5.0;
        constexpr double GuardExtensionMilliseconds = 1.0;
        constexpr double GuardActivationMinimumCadenceHz = 29.5;
        constexpr double GuardActivationMaximumCadenceHz = 30.5;
        constexpr double GuardActivationMinimumFineSpinP95Milliseconds = 1.5;
        constexpr double GuardMaximumNativeOvershootP95Milliseconds = 1.0;
        constexpr double GuardMinimumFineSpinImprovementMilliseconds = 0.5;
        constexpr uint32_t GuardBadWindowLimit = 2;
        constexpr std::size_t MinimumCoarseSamplesPerWindow = 96;
        constexpr uint32_t UnimprovedWindowLimit = 2;
        constexpr double CorrectedWaitTimeoutSlackMilliseconds = 25.0;
        constexpr DWORD CorrectedWaitMaximumTimeoutMilliseconds = 250;
        constexpr DWORD CreateWaitableTimerHighResolution = 0x00000002;

        constexpr uint8_t ExpectedPlatformSleepSignature[] = {
            0xF3, 0x0F, 0x59, 0x05, 0xB8, 0x01, 0x63, 0x02,
            0xF3, 0x48, 0x0F, 0x2C, 0xC0, 0x85, 0xC0, 0x75,
            0x07, 0x48, 0xFF, 0x25, 0xA8, 0x60, 0x59, 0x02,
            0x8B, 0xC8, 0x48, 0xFF, 0x25, 0x67, 0x66, 0x59,
            0x02
        };
        constexpr uint8_t ExpectedCoarseCallSignature[] = {
            0xF3, 0x0F, 0x5C, 0x05, 0xB8, 0xCB, 0xD7, 0x00,
            0xE8, 0x27, 0x63, 0x64, 0xFE
        };
        constexpr uint8_t ExpectedYieldCallSignature[] = {
            0x41, 0x0F, 0x28, 0xC0, 0xE8, 0xF7, 0x62, 0x64, 0xFE
        };

        using PlatformSleepFn = void(*)(float);
        using CreateWaitableTimerExWFn = HANDLE(WINAPI*)(
            LPSECURITY_ATTRIBUTES, LPCWSTR, DWORD, DWORD);
        using SetWaitableTimerExFn = BOOL(WINAPI*)(
            HANDLE, const LARGE_INTEGER*, LONG, PTIMERAPCROUTINE, LPVOID,
            PREASON_CONTEXT, ULONG);

        enum class WaitKind {
            Coarse,
            Yield,
            Other
        };

        struct CorrectedSleepAttempt {
            bool attempted = false;
            bool completed = false;
            uint64_t elapsedNanoseconds = 0;
            float remainingSeconds = 0.0f;
        };

        struct AtomicWaitCounters {
            std::atomic<uint64_t> calls{0};
            std::atomic<uint64_t> measuredCalls{0};
            std::atomic<uint64_t> requestedNanoseconds{0};
            std::atomic<uint64_t> actualNanoseconds{0};
            std::atomic<uint64_t> maximumActualNanoseconds{0};
        };

        struct HistogramData {
            uint64_t buckets[HistogramBucketCount]{};
            uint64_t count = 0;
            double totalMilliseconds = 0.0;
            double minimumMilliseconds = (std::numeric_limits<double>::max)();
            double maximumMilliseconds = 0.0;
        };

        struct EvidenceSample {
            double cadenceHz = 0.0;
            double engineWorkMilliseconds = 0.0;
            double coarseOvershootMilliseconds = 0.0;
            double fineSpinMilliseconds = 0.0;
            double nativeOvershootMilliseconds = 0.0;
            bool ratesValid = false;
            bool fixedFrameRate = false;
            bool hasCoarseWait = false;
        };

        struct MutableState {
            Snapshot snapshot{};
            HistogramData nativePacingWaitHistogram{};
            HistogramData nativePacingOvershootHistogram{};
            HistogramData nativeDeltaHistogram{};
            HistogramData engineWorkHistogram{};
            HistogramData frameGapHistogram{};
            EvidenceSample evidence[EvidenceWindowSize]{};
            std::size_t evidenceCount = 0;
            double overshootEwmaMilliseconds = 0.0;
            double cadenceDriftEwmaHz = 0.0;
            uint32_t guardReductionCooldownWindows = 0;
        };

        static_assert(std::is_trivially_copyable_v<Snapshot>);
        static_assert(std::is_trivially_copyable_v<FrameObservation>);

        SRWLOCK StateLock = SRWLOCK_INIT;
        MutableState State{};
        uintptr_t ExecutableBase = 0;
        PlatformSleepFn OriginalPlatformSleep = nullptr;
        LARGE_INTEGER PerformanceFrequency{};
        CreateWaitableTimerExWFn CreateWaitableTimerEx = nullptr;
        SetWaitableTimerExFn SetWaitableTimerEx = nullptr;
        HANDLE HighResolutionTimer = nullptr;

        std::atomic<CorrectionState> CurrentCorrectionState{CorrectionState::Disabled};
        std::atomic<bool> GuardReductionActive{false};
        std::atomic<uint64_t> CurrentFrameCoarseCalls{0};
        std::atomic<uint64_t> CurrentFrameCoarseRequestedNanoseconds{0};
        std::atomic<uint64_t> CurrentFrameCoarseActualNanoseconds{0};
        std::atomic<uint64_t> TimerFailures{0};
        std::atomic<uint64_t> GuardReductionAppliedCalls{0};
        std::atomic<uint64_t> GuardReductionAppliedNanoseconds{0};
        AtomicWaitCounters CoarseWait{};
        AtomicWaitCounters YieldWait{};
        AtomicWaitCounters OtherWait{};
        AtomicWaitCounters CorrectedWait{};
        AtomicWaitCounters GuardExtendedWait{};

        bool IsReadableMemory(const void* address, std::size_t size) {
            if (!address || size == 0)
                return false;

            MEMORY_BASIC_INFORMATION information{};
            if (VirtualQuery(address, &information, sizeof(information)) != sizeof(information) ||
                information.State != MEM_COMMIT || (information.Protect & PAGE_GUARD) != 0 ||
                (information.Protect & 0xFF) == PAGE_NOACCESS) {
                return false;
            }

            const uintptr_t start = reinterpret_cast<uintptr_t>(address);
            const uintptr_t regionEnd = reinterpret_cast<uintptr_t>(information.BaseAddress) + information.RegionSize;
            return start <= regionEnd && size <= regionEnd - start;
        }

        template <std::size_t Size>
        bool MatchesSignature(uintptr_t address, const uint8_t (&expected)[Size]) {
            const auto* bytes = reinterpret_cast<const uint8_t*>(address);
            return IsReadableMemory(bytes, Size) &&
                std::equal(expected, expected + Size, bytes);
        }

        bool IsExpectedExecutable(uintptr_t base) {
            const auto* dosHeader = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
            if (!IsReadableMemory(dosHeader, sizeof(*dosHeader)) ||
                dosHeader->e_magic != IMAGE_DOS_SIGNATURE || dosHeader->e_lfanew <= 0 ||
                dosHeader->e_lfanew > 0x1000) {
                return false;
            }

            const auto* ntHeaders = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dosHeader->e_lfanew);
            return IsReadableMemory(ntHeaders, sizeof(*ntHeaders)) &&
                ntHeaders->Signature == IMAGE_NT_SIGNATURE &&
                ntHeaders->FileHeader.TimeDateStamp == ExpectedExecutableTimestamp &&
                ntHeaders->OptionalHeader.SizeOfImage == ExpectedExecutableImageSize;
        }

        bool ValidateSignatures(uintptr_t base) {
            if (!MatchesSignature(base + PlatformSleepRva, ExpectedPlatformSleepSignature) ||
                !MatchesSignature(base + CoarseSleepCallRva - 8, ExpectedCoarseCallSignature) ||
                !MatchesSignature(base + YieldSleepCallRva - 4, ExpectedYieldCallSignature)) {
                return false;
            }

            // The byte signatures include both relative calls. Explicitly
            // resolve them as a second guard against an accidental call-site match.
            const auto resolvesToPlatformSleep = [base](uintptr_t callRva) {
                const auto* call = reinterpret_cast<const uint8_t*>(base + callRva);
                if (!IsReadableMemory(call, 5) || call[0] != 0xE8)
                    return false;
                const int32_t displacement = *reinterpret_cast<const int32_t*>(call + 1);
                const uintptr_t target = reinterpret_cast<uintptr_t>(call + 5) + displacement;
                return target == base + PlatformSleepRva;
            };

            return resolvesToPlatformSleep(CoarseSleepCallRva) &&
                resolvesToPlatformSleep(YieldSleepCallRva) &&
                IsReadableMemory(reinterpret_cast<const void*>(base + NativePacingWaitRva), sizeof(double)) &&
                IsReadableMemory(reinterpret_cast<const void*>(base + NativePacingOvershootRva), sizeof(double)) &&
                IsReadableMemory(reinterpret_cast<const void*>(base + NativeDeltaSecondsRva), sizeof(double));
        }

        uint64_t SecondsToNanoseconds(double seconds) {
            if (!std::isfinite(seconds) || seconds <= 0.0)
                return 0;
            const long double nanoseconds = static_cast<long double>(seconds) * 1'000'000'000.0L;
            if (nanoseconds >= static_cast<long double>((std::numeric_limits<uint64_t>::max)()))
                return (std::numeric_limits<uint64_t>::max)();
            return static_cast<uint64_t>(nanoseconds + 0.5L);
        }

        uint64_t CounterDeltaToNanoseconds(LONGLONG delta) {
            if (delta <= 0 || PerformanceFrequency.QuadPart <= 0)
                return 0;
            const long double nanoseconds = static_cast<long double>(delta) * 1'000'000'000.0L /
                static_cast<long double>(PerformanceFrequency.QuadPart);
            return static_cast<uint64_t>(nanoseconds + 0.5L);
        }

        void AtomicMaximum(std::atomic<uint64_t>& destination, uint64_t value) {
            uint64_t current = destination.load(std::memory_order_relaxed);
            while (current < value && !destination.compare_exchange_weak(
                current, value, std::memory_order_relaxed, std::memory_order_relaxed)) {
            }
        }

        void RecordWait(AtomicWaitCounters& counters, uint64_t requestedNanoseconds,
            uint64_t actualNanoseconds, bool measured) {
            counters.calls.fetch_add(1, std::memory_order_relaxed);
            counters.requestedNanoseconds.fetch_add(requestedNanoseconds, std::memory_order_relaxed);
            if (!measured)
                return;
            counters.measuredCalls.fetch_add(1, std::memory_order_relaxed);
            counters.actualNanoseconds.fetch_add(actualNanoseconds, std::memory_order_relaxed);
            AtomicMaximum(counters.maximumActualNanoseconds, actualNanoseconds);
        }

        WaitCounters ReadWaitCounters(const AtomicWaitCounters& counters) {
            WaitCounters result{};
            result.calls = counters.calls.load(std::memory_order_relaxed);
            result.measuredCalls = counters.measuredCalls.load(std::memory_order_relaxed);
            result.requestedNanoseconds = counters.requestedNanoseconds.load(std::memory_order_relaxed);
            result.actualNanoseconds = counters.actualNanoseconds.load(std::memory_order_relaxed);
            result.maximumActualNanoseconds = counters.maximumActualNanoseconds.load(std::memory_order_relaxed);
            return result;
        }

        void AddHistogramSample(HistogramData& histogram, double milliseconds) {
            if (!std::isfinite(milliseconds) || milliseconds < 0.0)
                return;
            std::size_t bucket = 0;
            while (bucket < HistogramBucketCount - 1 &&
                milliseconds > MillisecondHistogramUpperBounds[bucket]) {
                ++bucket;
            }
            ++histogram.buckets[bucket];
            ++histogram.count;
            histogram.totalMilliseconds += milliseconds;
            histogram.minimumMilliseconds = (std::min)(histogram.minimumMilliseconds, milliseconds);
            histogram.maximumMilliseconds = (std::max)(histogram.maximumMilliseconds, milliseconds);
        }

        HistogramSnapshot CopyHistogram(const HistogramData& histogram) {
            HistogramSnapshot result{};
            std::copy(std::begin(histogram.buckets), std::end(histogram.buckets),
                std::begin(result.buckets));
            result.count = histogram.count;
            result.totalMilliseconds = histogram.totalMilliseconds;
            result.minimumMilliseconds = histogram.count == 0 ? 0.0 : histogram.minimumMilliseconds;
            result.maximumMilliseconds = histogram.maximumMilliseconds;
            return result;
        }

        template <typename Projection>
        double Percentile(const EvidenceSample* samples, std::size_t count, double percentile,
            Projection projection) {
            std::array<double, EvidenceWindowSize> values{};
            std::size_t valueCount = 0;
            for (std::size_t index = 0; index < count; ++index) {
                const double value = projection(samples[index]);
                if (std::isfinite(value) && value >= 0.0)
                    values[valueCount++] = value;
            }
            if (valueCount == 0)
                return 0.0;
            std::sort(values.begin(), values.begin() + valueCount);
            const double clamped = (std::clamp)(percentile, 0.0, 1.0);
            const std::size_t position = static_cast<std::size_t>(
                std::ceil(clamped * static_cast<double>(valueCount)) - 1.0);
            return values[(std::min)(position, valueCount - 1)];
        }

        void SetFallbackLocked(FallbackReason reason) {
            CurrentCorrectionState.store(CorrectionState::Fallback, std::memory_order_release);
            GuardReductionActive.store(false, std::memory_order_release);
            State.snapshot.state = CorrectionState::Fallback;
            State.snapshot.guardReductionActive = false;
            if (State.snapshot.fallbackReason == FallbackReason::None)
                State.snapshot.fallbackReason = reason;
        }

        void DisableGuardReductionLocked(GuardReductionFallbackReason reason) {
            GuardReductionActive.store(false, std::memory_order_release);
            State.snapshot.guardReductionActive = false;
            State.snapshot.guardReductionPermanentlyDisabled = true;
            if (State.snapshot.guardReductionFallbackReason ==
                GuardReductionFallbackReason::None) {
                State.snapshot.guardReductionFallbackReason = reason;
            }
        }

        void SetFallback(FallbackReason reason) {
            AcquireSRWLockExclusive(&StateLock);
            SetFallbackLocked(reason);
            ReleaseSRWLockExclusive(&StateLock);
        }

        bool CreateCorrectionTimerLocked() {
            if (!CreateWaitableTimerEx || !SetWaitableTimerEx) {
                SetFallbackLocked(FallbackReason::TimerApiUnavailable);
                return false;
            }
            if (HighResolutionTimer)
                return true;

            HighResolutionTimer = CreateWaitableTimerEx(
                nullptr, nullptr, CreateWaitableTimerHighResolution, TIMER_ALL_ACCESS);
            if (!HighResolutionTimer) {
                TimerFailures.fetch_add(1, std::memory_order_relaxed);
                SetFallbackLocked(FallbackReason::TimerCreateFailed);
                return false;
            }

            State.snapshot.timerCreated = true;
            return true;
        }

        CorrectedSleepAttempt CorrectedSleep(float originalSeconds, float timerSeconds) {
            CorrectedSleepAttempt result{};
            result.remainingSeconds = originalSeconds;
            if (!HighResolutionTimer || originalSeconds <= 0.0f || timerSeconds <= 0.0f)
                return result;

            const uint64_t requestedNanoseconds = SecondsToNanoseconds(timerSeconds);
            const LONGLONG requestedHundredNanoseconds =
                (std::max)(LONGLONG{1}, static_cast<LONGLONG>((requestedNanoseconds + 99) / 100));
            LARGE_INTEGER dueTime{};
            dueTime.QuadPart = -requestedHundredNanoseconds;

            LARGE_INTEGER started{};
            LARGE_INTEGER completed{};
            QueryPerformanceCounter(&started);
            result.attempted = true;
            if (!SetWaitableTimerEx(HighResolutionTimer, &dueTime, 0, nullptr, nullptr, nullptr, 0)) {
                QueryPerformanceCounter(&completed);
                result.elapsedNanoseconds = CounterDeltaToNanoseconds(
                    completed.QuadPart - started.QuadPart);
                result.remainingSeconds = static_cast<float>((std::max)(
                    0.0, static_cast<double>(originalSeconds) -
                    static_cast<double>(result.elapsedNanoseconds) / 1'000'000'000.0));
                TimerFailures.fetch_add(1, std::memory_order_relaxed);
                SetFallback(FallbackReason::TimerSetFailed);
                RecordWait(CorrectedWait, requestedNanoseconds, result.elapsedNanoseconds, true);
                return result;
            }
            // A waitable-timer failure must never strand the game thread. The
            // native coarse wait is one frame-pacer slice (normally about 30 ms),
            // so requested time plus bounded slack is enough to distinguish an
            // oversleep from a timer that did not signal.
            const double requestedMilliseconds = static_cast<double>(timerSeconds) * 1000.0;
            const DWORD waitTimeoutMilliseconds = static_cast<DWORD>((std::clamp)(
                std::ceil(requestedMilliseconds + CorrectedWaitTimeoutSlackMilliseconds),
                1.0,
                static_cast<double>(CorrectedWaitMaximumTimeoutMilliseconds)));
            const DWORD waitResult = WaitForSingleObject(
                HighResolutionTimer, waitTimeoutMilliseconds);
            QueryPerformanceCounter(&completed);
            result.elapsedNanoseconds = CounterDeltaToNanoseconds(
                completed.QuadPart - started.QuadPart);
            result.remainingSeconds = static_cast<float>((std::max)(
                0.0, static_cast<double>(originalSeconds) -
                static_cast<double>(result.elapsedNanoseconds) / 1'000'000'000.0));
            RecordWait(CorrectedWait, requestedNanoseconds, result.elapsedNanoseconds, true);
            if (waitResult != WAIT_OBJECT_0) {
                CancelWaitableTimer(HighResolutionTimer);
                TimerFailures.fetch_add(1, std::memory_order_relaxed);
                SetFallback(waitResult == WAIT_TIMEOUT
                    ? FallbackReason::TimerWaitTimedOut
                    : FallbackReason::TimerWaitFailed);
                return result;
            }

            result.completed = true;
            return result;
        }

        __declspec(noinline) void PlatformSleepHook(float seconds) {
            const uintptr_t returnAddress = reinterpret_cast<uintptr_t>(_ReturnAddress());
            if (returnAddress != ExecutableBase + CoarseSleepReturnRva) {
                // PlatformSleep is shared by a very large number of engine and
                // worker-thread callers. Only this exact return address is the
                // positive frame-pacer wait. Preserve the native zero-duration
                // yield and every unrelated caller without QPC reads, counters,
                // conversions, or cross-thread atomics.
                OriginalPlatformSleep(seconds);
                return;
            }

            const uint64_t requestedNanoseconds = SecondsToNanoseconds(seconds);

            if (seconds > 0.0f &&
                std::isfinite(seconds) && seconds <= 1.0f &&
                CurrentCorrectionState.load(std::memory_order_acquire) == CorrectionState::Active) {
                const bool ExtendGuard = GuardReductionActive.load(std::memory_order_acquire);
                const float TimerSeconds = seconds + (ExtendGuard
                    ? static_cast<float>(GuardExtensionMilliseconds / 1000.0)
                    : 0.0f);
                const CorrectedSleepAttempt attempt = CorrectedSleep(seconds, TimerSeconds);
                if (attempt.attempted) {
                    uint64_t totalActualNanoseconds = attempt.elapsedNanoseconds;
                    if (!attempt.completed && attempt.remainingSeconds > 0.0f) {
                        LARGE_INTEGER retryStarted{};
                        LARGE_INTEGER retryCompleted{};
                        QueryPerformanceCounter(&retryStarted);
                        OriginalPlatformSleep(attempt.remainingSeconds);
                        QueryPerformanceCounter(&retryCompleted);
                        totalActualNanoseconds += CounterDeltaToNanoseconds(
                            retryCompleted.QuadPart - retryStarted.QuadPart);
                    }

                    RecordWait(CoarseWait, requestedNanoseconds, totalActualNanoseconds, true);
                    CurrentFrameCoarseCalls.fetch_add(1, std::memory_order_relaxed);
                    CurrentFrameCoarseRequestedNanoseconds.fetch_add(
                        requestedNanoseconds, std::memory_order_relaxed);
                    CurrentFrameCoarseActualNanoseconds.fetch_add(
                        totalActualNanoseconds, std::memory_order_relaxed);
                    if (ExtendGuard) {
                        RecordWait(GuardExtendedWait, SecondsToNanoseconds(TimerSeconds),
                            attempt.elapsedNanoseconds, true);
                        GuardReductionAppliedCalls.fetch_add(1, std::memory_order_relaxed);
                        GuardReductionAppliedNanoseconds.fetch_add(
                            SecondsToNanoseconds(GuardExtensionMilliseconds / 1000.0),
                            std::memory_order_relaxed);
                    }
                    return;
                }
            }

            LARGE_INTEGER started{};
            LARGE_INTEGER completed{};
            QueryPerformanceCounter(&started);
            OriginalPlatformSleep(seconds);
            QueryPerformanceCounter(&completed);
            const uint64_t actualNanoseconds = CounterDeltaToNanoseconds(
                completed.QuadPart - started.QuadPart);

            RecordWait(CoarseWait, requestedNanoseconds, actualNanoseconds, true);
            CurrentFrameCoarseCalls.fetch_add(1, std::memory_order_relaxed);
            CurrentFrameCoarseRequestedNanoseconds.fetch_add(requestedNanoseconds, std::memory_order_relaxed);
            CurrentFrameCoarseActualNanoseconds.fetch_add(actualNanoseconds, std::memory_order_relaxed);
        }

        void EvaluateEvidenceWindow() {
            if (State.evidenceCount != EvidenceWindowSize)
                return;

            ++State.snapshot.evaluatedWindows;
            std::size_t coarseSamples = 0;
            bool allRatesValid = true;
            bool anyFixedFrameRate = false;
            for (const EvidenceSample& sample : State.evidence) {
                coarseSamples += sample.hasCoarseWait ? 1 : 0;
                allRatesValid = allRatesValid && sample.ratesValid;
                anyFixedFrameRate = anyFixedFrameRate || sample.fixedFrameRate;
            }

            State.snapshot.rollingMedianCadenceHz = Percentile(
                State.evidence, EvidenceWindowSize, 0.50,
                [](const EvidenceSample& sample) { return sample.cadenceHz; });
            State.snapshot.rollingP95EngineWorkMilliseconds = Percentile(
                State.evidence, EvidenceWindowSize, 0.95,
                [](const EvidenceSample& sample) { return sample.engineWorkMilliseconds; });
            State.snapshot.rollingMedianCoarseOvershootMilliseconds = Percentile(
                State.evidence, EvidenceWindowSize, 0.50,
                [](const EvidenceSample& sample) {
                    return sample.hasCoarseWait ? sample.coarseOvershootMilliseconds : -1.0;
                });
            State.snapshot.rollingP95FineSpinMilliseconds = Percentile(
                State.evidence, EvidenceWindowSize, 0.95,
                [](const EvidenceSample& sample) {
                    return sample.hasCoarseWait ? sample.fineSpinMilliseconds : -1.0;
                });
            State.snapshot.rollingP95NativeOvershootMilliseconds = Percentile(
                State.evidence, EvidenceWindowSize, 0.95,
                [](const EvidenceSample& sample) {
                    return sample.nativeOvershootMilliseconds;
                });

            const CorrectionState correctionState = CurrentCorrectionState.load(std::memory_order_acquire);
            if (correctionState == CorrectionState::Observing) {
                const bool qualifies = allRatesValid && !anyFixedFrameRate &&
                    coarseSamples >= MinimumCoarseSamplesPerWindow &&
                    State.snapshot.rollingMedianCadenceHz < ActivationMaximumCadenceHz &&
                    State.snapshot.rollingP95EngineWorkMilliseconds <
                        ActivationMaximumEngineWorkP95Milliseconds &&
                    State.snapshot.rollingMedianCoarseOvershootMilliseconds >=
                        ActivationMinimumOvershootMedianMilliseconds;
                if (qualifies) {
                    ++State.snapshot.qualifiedWindows;
                    if (CreateCorrectionTimerLocked() &&
                        CurrentCorrectionState.load(std::memory_order_acquire) == CorrectionState::Observing) {
                        State.snapshot.state = CorrectionState::Active;
                        State.snapshot.correctionEverActivated = true;
                        State.snapshot.consecutiveUnimprovedWindows = 0;
                        CurrentCorrectionState.store(CorrectionState::Active, std::memory_order_release);
                    }
                }
            }
            else if (correctionState == CorrectionState::Active) {
                ++State.snapshot.activeWindows;
                if (State.snapshot.rollingP95FineSpinMilliseconds > ExcessiveFineSpinP95Milliseconds) {
                    SetFallbackLocked(FallbackReason::ExcessiveFineSpin);
                }
                else if (State.snapshot.rollingP95EngineWorkMilliseconds <
                    ActivationMaximumEngineWorkP95Milliseconds &&
                    State.snapshot.rollingMedianCadenceHz < ActiveMinimumAcceptedCadenceHz &&
                    !GuardReductionActive.load(std::memory_order_acquire)) {
                    ++State.snapshot.consecutiveUnimprovedWindows;
                    if (State.snapshot.consecutiveUnimprovedWindows >= UnimprovedWindowLimit)
                        SetFallbackLocked(FallbackReason::UnimprovedCadence);
                }
                else {
                    State.snapshot.consecutiveUnimprovedWindows = 0;
                }

                const bool guardEligibility = allRatesValid && !anyFixedFrameRate &&
                    coarseSamples >= MinimumCoarseSamplesPerWindow &&
                    State.snapshot.rollingMedianCadenceHz >=
                        GuardActivationMinimumCadenceHz &&
                    State.snapshot.rollingMedianCadenceHz <=
                        GuardActivationMaximumCadenceHz &&
                    State.snapshot.rollingP95EngineWorkMilliseconds <
                        ActivationMaximumEngineWorkP95Milliseconds &&
                    State.snapshot.rollingP95FineSpinMilliseconds >=
                        GuardActivationMinimumFineSpinP95Milliseconds;
                const bool correctionActive = CurrentCorrectionState.load(
                    std::memory_order_acquire) == CorrectionState::Active;
                if (!State.snapshot.guardReductionPermanentlyDisabled &&
                    (correctionActive || guardEligibility)) {
                    if (!GuardReductionActive.load(std::memory_order_acquire)) {
                        if (guardEligibility) {
                            State.snapshot.guardReductionBaselineFineSpinMilliseconds =
                                State.snapshot.rollingP95FineSpinMilliseconds;
                            State.snapshot.guardReductionActive = true;
                            State.snapshot.guardReductionEverActivated = true;
                            State.snapshot.guardReductionBadWindows = 0;
                            State.snapshot.guardReductionWindows = 0;
                            GuardReductionActive.store(true, std::memory_order_release);
                        }
                    }
                    else {
                        ++State.snapshot.guardReductionWindows;
                        const bool unloaded =
                            State.snapshot.rollingP95EngineWorkMilliseconds <
                            ActivationMaximumEngineWorkP95Milliseconds;
                        const bool overshootBad =
                            State.snapshot.rollingP95NativeOvershootMilliseconds >
                            GuardMaximumNativeOvershootP95Milliseconds;
                        const bool cadenceBad = unloaded &&
                            (State.snapshot.rollingMedianCadenceHz <
                                GuardActivationMinimumCadenceHz ||
                             State.snapshot.rollingMedianCadenceHz >
                                GuardActivationMaximumCadenceHz);
                        if (overshootBad || cadenceBad)
                            ++State.snapshot.guardReductionBadWindows;
                        else
                            State.snapshot.guardReductionBadWindows = 0;

                        if (State.snapshot.guardReductionBadWindows >= GuardBadWindowLimit) {
                            DisableGuardReductionLocked(overshootBad
                                ? GuardReductionFallbackReason::NativeOvershoot
                                : GuardReductionFallbackReason::CadenceRegression);
                        }
                        else if (State.snapshot.guardReductionWindows >= 2 &&
                            State.snapshot.guardReductionBaselineFineSpinMilliseconds -
                                State.snapshot.rollingP95FineSpinMilliseconds <
                                GuardMinimumFineSpinImprovementMilliseconds) {
                            DisableGuardReductionLocked(
                                GuardReductionFallbackReason::NoFineWaitImprovement);
                        }
                    }
                }
            }

            State.evidenceCount = 0;
        }
    }

    bool Install(uintptr_t executableBase, bool dedicatedServer) {
        AcquireSRWLockExclusive(&StateLock);
        if (State.snapshot.installAttempted) {
            const bool alreadyInstalled = State.snapshot.hookEnabled;
            ReleaseSRWLockExclusive(&StateLock);
            return alreadyInstalled;
        }
        State.snapshot.installAttempted = true;
        if (!dedicatedServer) {
            State.snapshot.installFailure = InstallFailure::NotDedicatedServer;
            State.snapshot.state = CorrectionState::Disabled;
            ReleaseSRWLockExclusive(&StateLock);
            return false;
        }
        ReleaseSRWLockExclusive(&StateLock);

        if (!executableBase || !IsExpectedExecutable(executableBase)) {
            AcquireSRWLockExclusive(&StateLock);
            State.snapshot.installFailure = executableBase
                ? InstallFailure::ExecutableBuildMismatch
                : InstallFailure::InvalidExecutable;
            ReleaseSRWLockExclusive(&StateLock);
            return false;
        }

        AcquireSRWLockExclusive(&StateLock);
        State.snapshot.executableBuildValid = true;
        ReleaseSRWLockExclusive(&StateLock);

        if (!ValidateSignatures(executableBase)) {
            AcquireSRWLockExclusive(&StateLock);
            State.snapshot.installFailure = InstallFailure::SignatureMismatch;
            ReleaseSRWLockExclusive(&StateLock);
            return false;
        }

        ExecutableBase = executableBase;
        QueryPerformanceFrequency(&PerformanceFrequency);
        HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
        if (kernel32) {
            CreateWaitableTimerEx = reinterpret_cast<CreateWaitableTimerExWFn>(
                GetProcAddress(kernel32, "CreateWaitableTimerExW"));
            SetWaitableTimerEx = reinterpret_cast<SetWaitableTimerExFn>(
                GetProcAddress(kernel32, "SetWaitableTimerEx"));
        }

        AcquireSRWLockExclusive(&StateLock);
        State.snapshot.signaturesValid = true;
        State.snapshot.highResolutionApiAvailable =
            CreateWaitableTimerEx != nullptr && SetWaitableTimerEx != nullptr;
        ReleaseSRWLockExclusive(&StateLock);

        const uintptr_t target = executableBase + PlatformSleepRva;
        MH_STATUS status = MH_CreateHook(reinterpret_cast<void*>(target),
            reinterpret_cast<void*>(&PlatformSleepHook),
            reinterpret_cast<void**>(&OriginalPlatformSleep));
        AcquireSRWLockExclusive(&StateLock);
        State.snapshot.minHookStatus = static_cast<int32_t>(status);
        if (status != MH_OK) {
            State.snapshot.installFailure = InstallFailure::MinHookCreateFailed;
            ReleaseSRWLockExclusive(&StateLock);
            return false;
        }
        State.snapshot.hookCreated = true;
        ReleaseSRWLockExclusive(&StateLock);

        status = MH_EnableHook(reinterpret_cast<void*>(target));
        AcquireSRWLockExclusive(&StateLock);
        State.snapshot.minHookStatus = static_cast<int32_t>(status);
        if (status != MH_OK) {
            State.snapshot.installFailure = InstallFailure::MinHookEnableFailed;
            ReleaseSRWLockExclusive(&StateLock);
            MH_RemoveHook(reinterpret_cast<void*>(target));
            OriginalPlatformSleep = nullptr;
            AcquireSRWLockExclusive(&StateLock);
            State.snapshot.hookCreated = false;
            ReleaseSRWLockExclusive(&StateLock);
            return false;
        }
        State.snapshot.hookEnabled = true;
        State.snapshot.state = CorrectionState::Observing;
        ReleaseSRWLockExclusive(&StateLock);
        CurrentCorrectionState.store(CorrectionState::Observing, std::memory_order_release);
        return true;
    }

    void ObserveFrame(const FrameObservation& observation) {
        const CorrectionState correctionState = CurrentCorrectionState.load(std::memory_order_acquire);
        if (correctionState == CorrectionState::Disabled)
            return;

        const uint64_t coarseCalls = CurrentFrameCoarseCalls.exchange(0, std::memory_order_acq_rel);
        const uint64_t coarseRequestedNanoseconds =
            CurrentFrameCoarseRequestedNanoseconds.exchange(0, std::memory_order_acq_rel);
        const uint64_t coarseActualNanoseconds =
            CurrentFrameCoarseActualNanoseconds.exchange(0, std::memory_order_acq_rel);

        const double nativeWaitMilliseconds = *reinterpret_cast<volatile const double*>(
            ExecutableBase + NativePacingWaitRva) * 1000.0;
        const double nativeOvershootMilliseconds = *reinterpret_cast<volatile const double*>(
            ExecutableBase + NativePacingOvershootRva) * 1000.0;
        const double nativeDeltaMilliseconds = *reinterpret_cast<volatile const double*>(
            ExecutableBase + NativeDeltaSecondsRva) * 1000.0;
        const double coarseRequestedMilliseconds =
            static_cast<double>(coarseRequestedNanoseconds) / 1'000'000.0;
        const double coarseActualMilliseconds =
            static_cast<double>(coarseActualNanoseconds) / 1'000'000.0;

        AcquireSRWLockExclusive(&StateLock);
        ++State.snapshot.observedFrames;
        State.snapshot.state = correctionState;
        State.snapshot.cvarMaxFps = observation.cvarMaxFps;
        State.snapshot.cachedMaxFps = observation.cachedMaxFps;
        State.snapshot.virtualMaxFps = observation.virtualMaxFps;
        State.snapshot.nativePacingWaitMilliseconds = nativeWaitMilliseconds;
        State.snapshot.nativePacingOvershootMilliseconds = nativeOvershootMilliseconds;
        State.snapshot.nativeDeltaMilliseconds = nativeDeltaMilliseconds;
        constexpr double EwmaAlpha = 0.125;
        State.overshootEwmaMilliseconds += EwmaAlpha *
            (nativeOvershootMilliseconds - State.overshootEwmaMilliseconds);
        const double TargetCadenceHz = observation.cachedMaxFps > 0.0
            ? observation.cachedMaxFps : observation.cvarMaxFps;
        const double ObservedCadenceHz = nativeDeltaMilliseconds > 0.0
            ? 1000.0 / nativeDeltaMilliseconds : 0.0;
        const double CadenceDrift = TargetCadenceHz > 0.0
            ? ObservedCadenceHz - TargetCadenceHz : 0.0;
        State.cadenceDriftEwmaHz += EwmaAlpha *
            (CadenceDrift - State.cadenceDriftEwmaHz);
        State.snapshot.overshootEwmaMilliseconds = State.overshootEwmaMilliseconds;
        State.snapshot.cadenceDriftEwmaHz = State.cadenceDriftEwmaHz;
        State.snapshot.guardReductionCooldownWindows =
            State.guardReductionCooldownWindows;

        AddHistogramSample(State.nativePacingWaitHistogram, nativeWaitMilliseconds);
        AddHistogramSample(State.nativePacingOvershootHistogram, nativeOvershootMilliseconds);
        AddHistogramSample(State.nativeDeltaHistogram, nativeDeltaMilliseconds);
        AddHistogramSample(State.engineWorkHistogram, observation.engineWorkMilliseconds);
        AddHistogramSample(State.frameGapHistogram, observation.frameGapMilliseconds);

        if (State.evidenceCount < EvidenceWindowSize) {
            EvidenceSample& sample = State.evidence[State.evidenceCount++];
            sample.cadenceHz = observation.frameGapMilliseconds > 0.0
                ? 1000.0 / observation.frameGapMilliseconds
                : 0.0;
            sample.engineWorkMilliseconds = observation.engineWorkMilliseconds;
            sample.coarseOvershootMilliseconds = coarseCalls > 0
                ? (std::max)(0.0, coarseActualMilliseconds - coarseRequestedMilliseconds)
                : 0.0;
            sample.fineSpinMilliseconds = coarseCalls > 0
                ? (std::max)(0.0, nativeWaitMilliseconds - coarseActualMilliseconds)
                : 0.0;
            sample.nativeOvershootMilliseconds = (std::max)(
                0.0, nativeOvershootMilliseconds);
            sample.ratesValid =
                std::isfinite(observation.cvarMaxFps) &&
                std::isfinite(observation.cachedMaxFps) &&
                std::isfinite(observation.virtualMaxFps) &&
                std::abs(observation.cvarMaxFps - ExpectedMaxFps) <= MaxFpsTolerance &&
                std::abs(observation.cachedMaxFps - ExpectedMaxFps) <= MaxFpsTolerance &&
                std::abs(observation.virtualMaxFps - ExpectedMaxFps) <= MaxFpsTolerance;
            sample.fixedFrameRate = observation.fixedFrameRate;
            sample.hasCoarseWait = coarseCalls > 0;
        }

        EvaluateEvidenceWindow();
        State.snapshot.timerFailures = TimerFailures.load(std::memory_order_relaxed);
        ReleaseSRWLockExclusive(&StateLock);
    }

    Snapshot GetSnapshot() {
        AcquireSRWLockShared(&StateLock);
        Snapshot result = State.snapshot;
        result.nativePacingWaitHistogram = CopyHistogram(State.nativePacingWaitHistogram);
        result.nativePacingOvershootHistogram = CopyHistogram(State.nativePacingOvershootHistogram);
        result.nativeDeltaHistogram = CopyHistogram(State.nativeDeltaHistogram);
        result.engineWorkHistogram = CopyHistogram(State.engineWorkHistogram);
        result.frameGapHistogram = CopyHistogram(State.frameGapHistogram);
        ReleaseSRWLockShared(&StateLock);

        result.state = CurrentCorrectionState.load(std::memory_order_acquire);
        result.guardReductionActive = GuardReductionActive.load(std::memory_order_acquire);
        result.timerFailures = TimerFailures.load(std::memory_order_relaxed);
        result.guardReductionAppliedCalls =
            GuardReductionAppliedCalls.load(std::memory_order_relaxed);
        result.guardReductionAppliedNanoseconds =
            GuardReductionAppliedNanoseconds.load(std::memory_order_relaxed);
        result.coarseWait = ReadWaitCounters(CoarseWait);
        result.yieldWait = ReadWaitCounters(YieldWait);
        result.otherWait = ReadWaitCounters(OtherWait);
        result.correctedWait = ReadWaitCounters(CorrectedWait);
        result.guardExtendedWait = ReadWaitCounters(GuardExtendedWait);
        return result;
    }

    const char* CorrectionStateName(CorrectionState state) {
        switch (state) {
        case CorrectionState::Disabled: return "disabled";
        case CorrectionState::Observing: return "observing";
        case CorrectionState::Active: return "active";
        case CorrectionState::Fallback: return "fallback";
        default: return "unknown";
        }
    }

    const char* InstallFailureName(InstallFailure failure) {
        switch (failure) {
        case InstallFailure::None: return "none";
        case InstallFailure::NotDedicatedServer: return "not_dedicated_server";
        case InstallFailure::InvalidExecutable: return "invalid_executable";
        case InstallFailure::ExecutableBuildMismatch: return "executable_build_mismatch";
        case InstallFailure::SignatureMismatch: return "signature_mismatch";
        case InstallFailure::MinHookCreateFailed: return "minhook_create_failed";
        case InstallFailure::MinHookEnableFailed: return "minhook_enable_failed";
        default: return "unknown";
        }
    }

    const char* FallbackReasonName(FallbackReason reason) {
        switch (reason) {
        case FallbackReason::None: return "none";
        case FallbackReason::TimerApiUnavailable: return "timer_api_unavailable";
        case FallbackReason::TimerCreateFailed: return "timer_create_failed";
        case FallbackReason::TimerSetFailed: return "timer_set_failed";
        case FallbackReason::TimerWaitTimedOut: return "timer_wait_timed_out";
        case FallbackReason::TimerWaitFailed: return "timer_wait_failed";
        case FallbackReason::UnimprovedCadence: return "unimproved_cadence";
        case FallbackReason::ExcessiveFineSpin: return "excessive_fine_spin";
        default: return "unknown";
        }
    }

    const char* GuardReductionFallbackReasonName(GuardReductionFallbackReason reason) {
        switch (reason) {
        case GuardReductionFallbackReason::None: return "none";
        case GuardReductionFallbackReason::NativeOvershoot: return "native_overshoot";
        case GuardReductionFallbackReason::CadenceRegression: return "cadence_regression";
        case GuardReductionFallbackReason::NoFineWaitImprovement: return "no_fine_wait_improvement";
        default: return "unknown";
        }
    }

    void Shutdown() {
        CurrentCorrectionState.store(CorrectionState::Disabled, std::memory_order_release);
        GuardReductionActive.store(false, std::memory_order_release);
        bool hookEnabled = false;
        AcquireSRWLockShared(&StateLock);
        hookEnabled = State.snapshot.hookEnabled;
        ReleaseSRWLockShared(&StateLock);
        if (ExecutableBase && hookEnabled) {
            const void* target = reinterpret_cast<const void*>(ExecutableBase + PlatformSleepRva);
            MH_DisableHook(const_cast<void*>(target));
            MH_RemoveHook(const_cast<void*>(target));
        }
        if (HighResolutionTimer) {
            CloseHandle(HighResolutionTimer);
            HighResolutionTimer = nullptr;
        }

        AcquireSRWLockExclusive(&StateLock);
        State.snapshot.hookEnabled = false;
        State.snapshot.state = CorrectionState::Disabled;
        ReleaseSRWLockExclusive(&StateLock);
    }
}
