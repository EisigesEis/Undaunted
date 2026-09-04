#include "ServerPerformance.h"

#include <Windows.h>
#include <TlHelp32.h>
#include <shellapi.h>
#include <process.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <iomanip>
#include <new>
#include <ranges>
#include <sstream>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "AssetOptimization.h"
#include "Networking.h"
#include "SDK.hpp"
#include "ServerPacing.h"

using namespace SDK;

namespace ServerPerformance {
    namespace {
        constexpr std::array<double, 9> BucketUpperBoundsMs{
            1.0, 2.0, 4.0, 8.0, 16.0, 33.0, 50.0, 100.0, 250.0
        };
        constexpr std::array<const char*, Networking::ReplicationBucketCount> ReplicationBucketNames{
            "immediate", "archonCharacter", "archonBehemoth", "projectile", "pawnOrCharacter", "movementActor"
        };
        constexpr std::array<const char*, Networking::UrgentReplicationReasonCount> UrgentReplicationReasonNames{
            "stagger", "bleedout", "revive", "dodge"
        };
        constexpr std::array<const char*, Networking::CombatEventCount> CombatEventNames{
            "bleedoutStarted", "reviveCompleted", "reviveQuickItem", "dodgeRequested",
            "dodgePerformed", "comboStarted", "comboNextMove", "comboStateChanged",
            "clientTryHit", "serverAcceptHit", "serverRefuseHit", "processHitOnServer",
            "combatTextQueued", "combatTextMulticast", "staggerConfirmed"
        };
        constexpr uint32_t ConfiguredMaxFps = 30;
        constexpr size_t MaximumPendingLifecycleRecords = 256;
        constexpr size_t LifecycleEventNameCapacity = 64;
        constexpr size_t LifecycleFieldsCapacity = 1024;
        constexpr size_t MaximumThreadCpuEntries = 8;
        constexpr size_t ThreadDescriptionCapacity = 64;
        constexpr std::wstring_view DllHashArgumentPrefix = L"-undauntedDllSha256=";

        struct LifecycleRecord {
            SYSTEMTIME Timestamp{};
            std::array<char, LifecycleEventNameCapacity> EventName{};
            std::array<char, LifecycleFieldsCapacity> FieldsJson{};
        };

        struct ThreadCpuEntry {
            DWORD ThreadId = 0;
            uint64_t Cpu100Nanoseconds = 0;
            std::array<char, ThreadDescriptionCapacity> Description{};
        };

        struct CpuAttribution {
            DWORD GameThreadId = 0;
            uint64_t ProcessCpu100Nanoseconds = 0;
            uint64_t GameThreadCpu100Nanoseconds = 0;
            std::array<ThreadCpuEntry, MaximumThreadCpuEntries> TopThreads{};
            size_t TopThreadCount = 0;
            DWORD SamplingError = ERROR_SUCCESS;
        };

        struct Histogram {
            std::array<uint64_t, BucketUpperBoundsMs.size() + 1> counts{};
            uint64_t samples = 0;
            double total = 0.0;
            double maximum = 0.0;

            void Add(double Value) {
                if (!std::isfinite(Value) || Value < 0.0) return;
                ++samples;
                total += Value;
                maximum = (std::max)(maximum, Value);
                size_t Bucket = 0;
                while (Bucket < BucketUpperBoundsMs.size() && Value > BucketUpperBoundsMs[Bucket]) ++Bucket;
                ++counts[Bucket];
            }

            double Percentile(double Quantile) const {
                if (samples == 0) return 0.0;
                const uint64_t Target = (std::max)(uint64_t{ 1 },
                    static_cast<uint64_t>(samples * Quantile + 0.999999));
                uint64_t Seen = 0;
                for (size_t Index = 0; Index < counts.size(); ++Index) {
                    Seen += counts[Index];
                    if (Seen >= Target)
                        return Index < BucketUpperBoundsMs.size() ? BucketUpperBoundsMs[Index] : maximum;
                }
                return maximum;
            }

            void Reset() { *this = {}; }
        };

        struct IntervalSnapshot {
            SYSTEMTIME Timestamp{};
            double ElapsedSeconds = 0.0;
            double ObservedMaxFps = 0.0;
            Histogram EngineTickDuration{};
            Histogram FrameGap{};
            Histogram NetworkingDuration{};
            uint64_t LongFrames50Ms = 0;
            uint64_t LongFrames100Ms = 0;
            uint64_t LongFrames250Ms = 0;
            uint64_t AbilityRpcMatched = 0;
            uint64_t AbilityRpcActivated = 0;
            uint64_t AbilityRpcRejected = 0;
            uint64_t AbilityRpcOriginalFallback = 0;
            uint64_t ProcessEventCalls = 0;
            uint64_t ProcessEventNetServerCandidates = 0;
            uint64_t ProcessEventNameLookups = 0;
            uint64_t ProcessEventNameFallbacks = 0;
            uint64_t ProcessEventFunctionMatches = 0;
            uint64_t ProcessEventOriginalCalls = 0;
            uint64_t DroppedLifecycleRecords = 0;
            uint64_t DroppedIntervalSnapshots = 0;
            uint64_t PreviousIntervalWriteFailures = 0;
            DWORD PreviousIntervalWriteError = ERROR_SUCCESS;
            uint64_t WriterSerializationCalls = 0;
            uint64_t WriterSerializationMicroseconds = 0;
            uint64_t WriterSerializationMaximumMicroseconds = 0;
            uint64_t WriterWriteFlushCalls = 0;
            uint64_t WriterWriteFlushMicroseconds = 0;
            uint64_t WriterWriteFlushMaximumMicroseconds = 0;
            int32_t NetServerMaxTickRate = 0;
            int32_t MaxNetTickRate = 0;
            int32_t MaxClientRate = 0;
            uint32_t TrackedConnections = 0;
            uint32_t RawConnections = 0;
            CpuAttribution Cpu{};
            Networking::ProfilingCounters NetworkingCounters{};
            ServerPacing::Snapshot Pacing{};
            std::array<LifecycleRecord, MaximumPendingLifecycleRecords> LifecycleRecords{};
            size_t LifecycleRecordCount = 0;
        };

        bool ConfiguredEnabled = false;
        bool Enabled = false;
        bool Started = false;
        uint32_t IntervalSeconds = 30;
        std::string ServerId;
        std::string MapPath;
        std::string DllSha256;
        std::filesystem::path ProfilePath;
        std::filesystem::path ProfileOutputDirectory;
        uint64_t MaximumProfileBytes = 64ull * 1024ull * 1024ull;
        uint64_t TotalProfileBytesWritten = 0;
        HANDLE ProfileFile = INVALID_HANDLE_VALUE;
        HANDLE PendingSnapshotEvent = nullptr;
        HANDLE StopEvent = nullptr;
        HANDLE WriterThread = nullptr;
        SRWLOCK PendingSnapshotLock = SRWLOCK_INIT;
        IntervalSnapshot CaptureSnapshot{};
        // Keep the cross-thread handoff buffer on writable heap storage. With
        // LTCG, MSVC placed the previously zero-initialized file-static buffer
        // in .rdata even though PublishSnapshot assigns to it, causing the
        // first 30-second snapshot to fault inside VCRUNTIME memcpy.
        IntervalSnapshot* PendingSnapshot = nullptr;
        IntervalSnapshot WriterSnapshot{};
        bool HasPendingSnapshot = false;
        std::atomic<uint64_t> IntervalBytesWritten{ 0 };
        std::atomic<uint64_t> IntervalWriteFailures{ 0 };
        std::atomic<DWORD> LastIntervalWriteError{ ERROR_SUCCESS };
        std::atomic<uint64_t> WriterSerializationCalls{ 0 };
        std::atomic<uint64_t> WriterSerializationMicroseconds{ 0 };
        std::atomic<uint64_t> WriterSerializationMaximumMicroseconds{ 0 };
        std::atomic<uint64_t> WriterWriteFlushCalls{ 0 };
        std::atomic<uint64_t> WriterWriteFlushMicroseconds{ 0 };
        std::atomic<uint64_t> WriterWriteFlushMaximumMicroseconds{ 0 };
        uint64_t StartupBytesWritten = 0;
        DWORD StartupWriteError = ERROR_SUCCESS;
        DWORD WriterStartError = ERROR_SUCCESS;
        bool StartupWriteSucceeded = false;
        bool WriterStarted = false;
        bool ExitHandlerRegistered = false;
        uint64_t DroppedIntervalSnapshots = 0;
        std::chrono::steady_clock::time_point IntervalStarted{};
        Histogram EngineTickDuration;
        Histogram FrameGap;
        Histogram NetworkingDuration;
        uint64_t LongFrames50Ms = 0;
        uint64_t LongFrames100Ms = 0;
        uint64_t LongFrames250Ms = 0;
        uint64_t AbilityRpcMatched = 0;
        uint64_t AbilityRpcActivated = 0;
        uint64_t AbilityRpcRejected = 0;
        uint64_t AbilityRpcOriginalFallback = 0;
        uint64_t ProcessEventCalls = 0;
        uint64_t ProcessEventNetServerCandidates = 0;
        uint64_t ProcessEventNameLookups = 0;
        uint64_t ProcessEventNameFallbacks = 0;
        uint64_t ProcessEventFunctionMatches = 0;
        uint64_t ProcessEventOriginalCalls = 0;
        std::array<LifecycleRecord, MaximumPendingLifecycleRecords> PendingLifecycleRecords{};
        size_t PendingLifecycleRecordCount = 0;
        uint64_t DroppedLifecycleRecords = 0;
        std::atomic<DWORD> GameThreadId{ 0 };
        uint64_t PreviousProcessCpu100Nanoseconds = 0;
        std::unordered_map<DWORD, uint64_t> PreviousThreadCpu100Nanoseconds;

        std::string WideToUtf8(const std::wstring& Value);

        uint64_t FileTimeValue(const FILETIME& Value) {
            ULARGE_INTEGER Combined{};
            Combined.LowPart = Value.dwLowDateTime;
            Combined.HighPart = Value.dwHighDateTime;
            return Combined.QuadPart;
        }

        void CopyThreadDescription(HANDLE Thread, ThreadCpuEntry& Entry) {
            using GetThreadDescriptionType = HRESULT(WINAPI*)(HANDLE, PWSTR*);
            static const auto GetDescription =
                reinterpret_cast<GetThreadDescriptionType>(GetProcAddress(
                    GetModuleHandleW(L"Kernel32.dll"), "GetThreadDescription"));
            if (!GetDescription)
                return;

            PWSTR Description = nullptr;
            if (FAILED(GetDescription(Thread, &Description)) || !Description)
                return;
            const std::string Utf8 = WideToUtf8(std::wstring(Description));
            LocalFree(Description);
            const size_t Length = (std::min)(
                Utf8.size(), Entry.Description.size() - 1);
            std::memcpy(Entry.Description.data(), Utf8.data(), Length);
        }

        void SampleThreadCpu(CpuAttribution& Output) {
            Output = {};
            Output.GameThreadId = GameThreadId.load(std::memory_order_relaxed);

            FILETIME Created{}, Exited{}, Kernel{}, User{};
            if (!GetProcessTimes(GetCurrentProcess(),
                &Created, &Exited, &Kernel, &User)) {
                Output.SamplingError = GetLastError();
                return;
            }
            const uint64_t ProcessTotal =
                FileTimeValue(Kernel) + FileTimeValue(User);
            if (PreviousProcessCpu100Nanoseconds != 0)
                Output.ProcessCpu100Nanoseconds =
                    ProcessTotal - PreviousProcessCpu100Nanoseconds;
            PreviousProcessCpu100Nanoseconds = ProcessTotal;

            const HANDLE Snapshot = CreateToolhelp32Snapshot(
                TH32CS_SNAPTHREAD, 0);
            if (Snapshot == INVALID_HANDLE_VALUE) {
                Output.SamplingError = GetLastError();
                return;
            }

            struct ThreadDelta {
                DWORD ThreadId = 0;
                uint64_t Cpu100Nanoseconds = 0;
            };
            std::vector<ThreadDelta> Deltas;
            std::unordered_map<DWORD, uint64_t> CurrentTotals;
            THREADENTRY32 Entry{};
            Entry.dwSize = sizeof(Entry);
            if (Thread32First(Snapshot, &Entry)) {
                do {
                    if (Entry.th32OwnerProcessID != GetCurrentProcessId())
                        continue;
                    const HANDLE Thread = OpenThread(
                        THREAD_QUERY_LIMITED_INFORMATION, FALSE,
                        Entry.th32ThreadID);
                    if (!Thread)
                        continue;
                    FILETIME ThreadCreated{}, ThreadExited{},
                        ThreadKernel{}, ThreadUser{};
                    if (GetThreadTimes(Thread, &ThreadCreated, &ThreadExited,
                        &ThreadKernel, &ThreadUser)) {
                        const uint64_t Total =
                            FileTimeValue(ThreadKernel) +
                            FileTimeValue(ThreadUser);
                        CurrentTotals.emplace(Entry.th32ThreadID, Total);
                        const auto Previous =
                            PreviousThreadCpu100Nanoseconds.find(
                                Entry.th32ThreadID);
                        const uint64_t Delta =
                            Previous != PreviousThreadCpu100Nanoseconds.end() &&
                            Total >= Previous->second
                                ? Total - Previous->second
                                : 0;
                        Deltas.push_back({ Entry.th32ThreadID, Delta });
                        if (Entry.th32ThreadID == Output.GameThreadId)
                            Output.GameThreadCpu100Nanoseconds = Delta;
                    }
                    CloseHandle(Thread);
                } while (Thread32Next(Snapshot, &Entry));
            }
            else {
                Output.SamplingError = GetLastError();
            }
            CloseHandle(Snapshot);
            PreviousThreadCpu100Nanoseconds.swap(CurrentTotals);

            std::ranges::sort(Deltas, std::greater{},
                &ThreadDelta::Cpu100Nanoseconds);
            Output.TopThreadCount = (std::min)(
                Deltas.size(), Output.TopThreads.size());
            for (size_t Index = 0; Index < Output.TopThreadCount; ++Index) {
                ThreadCpuEntry& Destination = Output.TopThreads[Index];
                Destination.ThreadId = Deltas[Index].ThreadId;
                Destination.Cpu100Nanoseconds =
                    Deltas[Index].Cpu100Nanoseconds;
                const HANDLE Thread = OpenThread(
                    THREAD_QUERY_LIMITED_INFORMATION, FALSE,
                    Destination.ThreadId);
                if (Thread) {
                    CopyThreadDescription(Thread, Destination);
                    CloseHandle(Thread);
                }
            }
        }

        std::string JsonEscape(const std::string& Value) {
            std::string Result;
            Result.reserve(Value.size());
            for (const unsigned char Character : Value) {
                switch (Character) {
                case '\\': Result += "\\\\"; break;
                case '"': Result += "\\\""; break;
                case '\n': Result += "\\n"; break;
                case '\r': Result += "\\r"; break;
                case '\t': Result += "\\t"; break;
                default: if (Character >= 0x20) Result += static_cast<char>(Character); break;
                }
            }
            return Result;
        }

        double JsonNumber(double Value) {
            return std::isfinite(Value) ? Value : 0.0;
        }

        uint64_t ElapsedMicroseconds(std::chrono::steady_clock::time_point StartedAt) {
            const auto Elapsed = std::chrono::steady_clock::now() - StartedAt;
            return static_cast<uint64_t>((std::max)(int64_t{ 0 },
                std::chrono::duration_cast<std::chrono::microseconds>(Elapsed).count()));
        }

        void AtomicMaximum(std::atomic<uint64_t>& Destination, uint64_t Value) {
            uint64_t Current = Destination.load(std::memory_order_relaxed);
            while (Current < Value && !Destination.compare_exchange_weak(
                Current, Value, std::memory_order_relaxed, std::memory_order_relaxed)) {
            }
        }

        std::string FormatUtcTimestamp(const SYSTEMTIME& Time, bool FilenameSafe) {
            char Buffer[40]{};
            if (FilenameSafe) {
                sprintf_s(Buffer, "%04u%02u%02uT%02u%02u%02u%03uZ", Time.wYear, Time.wMonth, Time.wDay,
                    Time.wHour, Time.wMinute, Time.wSecond, Time.wMilliseconds);
            }
            else {
                sprintf_s(Buffer, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", Time.wYear, Time.wMonth, Time.wDay,
                    Time.wHour, Time.wMinute, Time.wSecond, Time.wMilliseconds);
            }
            return Buffer;
        }

        std::string UtcTimestamp(bool FilenameSafe) {
            SYSTEMTIME Time{};
            GetSystemTime(&Time);
            return FormatUtcTimestamp(Time, FilenameSafe);
        }

        std::filesystem::path ExecutableDirectory() {
            std::wstring Buffer(32768, L'\0');
            const DWORD Length = GetModuleFileNameW(nullptr, Buffer.data(), static_cast<DWORD>(Buffer.size()));
            if (Length == 0 || Length >= Buffer.size()) return std::filesystem::current_path();
            Buffer.resize(Length);
            return std::filesystem::path(Buffer).parent_path();
        }

        std::string WideToUtf8(const std::wstring& Value) {
            if (Value.empty()) return {};
            const int Required = WideCharToMultiByte(CP_UTF8, 0, Value.data(), static_cast<int>(Value.size()),
                nullptr, 0, nullptr, nullptr);
            if (Required <= 0) return {};
            std::string Result(static_cast<size_t>(Required), '\0');
            WideCharToMultiByte(CP_UTF8, 0, Value.data(), static_cast<int>(Value.size()),
                Result.data(), Required, nullptr, nullptr);
            return Result;
        }

        bool IsSha256(const std::wstring_view Value) {
            if (Value.size() != 64) return false;
            return std::all_of(Value.begin(), Value.end(), [](wchar_t Character) {
                return (Character >= L'0' && Character <= L'9')
                    || (Character >= L'a' && Character <= L'f')
                    || (Character >= L'A' && Character <= L'F');
            });
        }

        std::string ReadDllSha256Argument() {
            int ArgumentCount = 0;
            wchar_t** Arguments = CommandLineToArgvW(GetCommandLineW(), &ArgumentCount);
            if (!Arguments) return {};

            std::string Result;
            for (int Index = 0; Index < ArgumentCount; ++Index) {
                const std::wstring_view Argument(Arguments[Index]);
                if (!Argument.starts_with(DllHashArgumentPrefix)) continue;
                const std::wstring_view Value = Argument.substr(DllHashArgumentPrefix.size());
                if (!IsSha256(Value)) break;
                std::wstring Normalized(Value);
                std::transform(Normalized.begin(), Normalized.end(), Normalized.begin(), [](wchar_t Character) {
                    return Character >= L'A' && Character <= L'F' ? Character + (L'a' - L'A') : Character;
                });
                Result = WideToUtf8(Normalized);
                break;
            }

            LocalFree(Arguments);
            return Result;
        }

        void WriteHistogram(std::ostream& Stream, const Histogram& Value) {
            Stream << "{\"samples\":" << Value.samples
                << ",\"mean\":" << (Value.samples ? Value.total / Value.samples : 0.0)
                << ",\"p50Upper\":" << Value.Percentile(0.50)
                << ",\"p95Upper\":" << Value.Percentile(0.95)
                << ",\"p99Upper\":" << Value.Percentile(0.99)
                << ",\"max\":" << Value.maximum << ",\"buckets\":[";
            for (size_t Index = 0; Index < Value.counts.size(); ++Index) {
                if (Index) Stream << ',';
                Stream << Value.counts[Index];
            }
            Stream << "]}";
        }

        void WriteWaitCounters(std::ostream& Stream, const ServerPacing::WaitCounters& Counters) {
            Stream << "{\"calls\":" << Counters.calls
                << ",\"measuredCalls\":" << Counters.measuredCalls
                << ",\"requestedMs\":" << static_cast<double>(Counters.requestedNanoseconds) / 1'000'000.0
                << ",\"actualMs\":" << static_cast<double>(Counters.actualNanoseconds) / 1'000'000.0
                << ",\"maximumActualMs\":" << static_cast<double>(Counters.maximumActualNanoseconds) / 1'000'000.0
                << '}';
        }

        void WritePacingHistogram(std::ostream& Stream, const ServerPacing::HistogramSnapshot& Histogram) {
            Stream << "{\"samples\":" << Histogram.count
                << ",\"mean\":" << (Histogram.count ? Histogram.totalMilliseconds / Histogram.count : 0.0)
                << ",\"min\":" << Histogram.minimumMilliseconds
                << ",\"max\":" << Histogram.maximumMilliseconds
                << ",\"buckets\":[";
            for (size_t Index = 0; Index < ServerPacing::HistogramBucketCount; ++Index) {
                if (Index) Stream << ',';
                Stream << Histogram.buckets[Index];
            }
            Stream << "]}";
        }

        void WritePacing(std::ostream& Stream, const ServerPacing::Snapshot& Pacing) {
            Stream << "{\"state\":\"" << ServerPacing::CorrectionStateName(Pacing.state)
                << "\",\"installFailure\":\"" << ServerPacing::InstallFailureName(Pacing.installFailure)
                << "\",\"fallbackReason\":\"" << ServerPacing::FallbackReasonName(Pacing.fallbackReason)
                << "\",\"minHookStatus\":" << Pacing.minHookStatus
                << ",\"installAttempted\":" << (Pacing.installAttempted ? "true" : "false")
                << ",\"executableBuildValid\":" << (Pacing.executableBuildValid ? "true" : "false")
                << ",\"signaturesValid\":" << (Pacing.signaturesValid ? "true" : "false")
                << ",\"hookCreated\":" << (Pacing.hookCreated ? "true" : "false")
                << ",\"hookEnabled\":" << (Pacing.hookEnabled ? "true" : "false")
                << ",\"highResolutionApiAvailable\":" << (Pacing.highResolutionApiAvailable ? "true" : "false")
                << ",\"timerCreated\":" << (Pacing.timerCreated ? "true" : "false")
                << ",\"correctionEverActivated\":" << (Pacing.correctionEverActivated ? "true" : "false")
                << ",\"guardReductionActive\":" << (Pacing.guardReductionActive ? "true" : "false")
                << ",\"guardReductionEverActivated\":" << (Pacing.guardReductionEverActivated ? "true" : "false")
                << ",\"guardReductionPermanentlyDisabled\":" << (Pacing.guardReductionPermanentlyDisabled ? "true" : "false")
                << ",\"guardReductionFallbackReason\":\""
                << ServerPacing::GuardReductionFallbackReasonName(
                    Pacing.guardReductionFallbackReason) << '"'
                << ",\"observedFrames\":" << Pacing.observedFrames
                << ",\"evaluatedWindows\":" << Pacing.evaluatedWindows
                << ",\"qualifiedWindows\":" << Pacing.qualifiedWindows
                << ",\"activeWindows\":" << Pacing.activeWindows
                << ",\"consecutiveUnimprovedWindows\":" << Pacing.consecutiveUnimprovedWindows
                << ",\"timerFailures\":" << Pacing.timerFailures
                << ",\"guardReductionWindows\":" << Pacing.guardReductionWindows
                << ",\"guardReductionBadWindows\":" << Pacing.guardReductionBadWindows
                << ",\"guardReductionAppliedCalls\":" << Pacing.guardReductionAppliedCalls
                << ",\"guardReductionAppliedNanoseconds\":"
                << Pacing.guardReductionAppliedNanoseconds
                << ",\"rates\":{\"cvarMaxFps\":" << JsonNumber(Pacing.cvarMaxFps)
                << ",\"cachedMaxFps\":" << JsonNumber(Pacing.cachedMaxFps)
                << ",\"virtualMaxFps\":" << JsonNumber(Pacing.virtualMaxFps)
                << ",\"rollingMedianCadenceHz\":" << JsonNumber(Pacing.rollingMedianCadenceHz) << '}'
                << ",\"evidence\":{\"nativePacingWaitMs\":" << JsonNumber(Pacing.nativePacingWaitMilliseconds)
                << ",\"nativePacingOvershootMs\":" << JsonNumber(Pacing.nativePacingOvershootMilliseconds)
                << ",\"nativeDeltaMs\":" << JsonNumber(Pacing.nativeDeltaMilliseconds)
                << ",\"rollingP95EngineWorkMs\":" << JsonNumber(Pacing.rollingP95EngineWorkMilliseconds)
                << ",\"rollingMedianCoarseOvershootMs\":" << JsonNumber(Pacing.rollingMedianCoarseOvershootMilliseconds)
                << ",\"rollingP95FineSpinMs\":" << JsonNumber(Pacing.rollingP95FineSpinMilliseconds)
                << ",\"rollingP95NativeOvershootMs\":" << JsonNumber(Pacing.rollingP95NativeOvershootMilliseconds)
                << ",\"guardReductionBaselineFineSpinMs\":"
                << JsonNumber(Pacing.guardReductionBaselineFineSpinMilliseconds) << '}'
                << ",\"waits\":{\"coarse\":";
            WriteWaitCounters(Stream, Pacing.coarseWait);
            Stream << ",\"yield\":";
            WriteWaitCounters(Stream, Pacing.yieldWait);
            Stream << ",\"other\":";
            WriteWaitCounters(Stream, Pacing.otherWait);
            Stream << ",\"corrected\":";
            WriteWaitCounters(Stream, Pacing.correctedWait);
            Stream << ",\"guardExtended\":";
            WriteWaitCounters(Stream, Pacing.guardExtendedWait);
            Stream << "},\"histograms\":{\"nativePacingWaitMs\":";
            WritePacingHistogram(Stream, Pacing.nativePacingWaitHistogram);
            Stream << ",\"nativePacingOvershootMs\":";
            WritePacingHistogram(Stream, Pacing.nativePacingOvershootHistogram);
            Stream << ",\"nativeDeltaMs\":";
            WritePacingHistogram(Stream, Pacing.nativeDeltaHistogram);
            Stream << ",\"engineWorkMs\":";
            WritePacingHistogram(Stream, Pacing.engineWorkHistogram);
            Stream << ",\"frameGapMs\":";
            WritePacingHistogram(Stream, Pacing.frameGapHistogram);
            Stream << "}}";
        }

        void WriteActorPropertyDistribution(
            std::ostream& Stream,
            const Networking::ProfilingCounters& Counters
        ) {
            Stream << "{\"samples\":" << Counters.ActorPropertySamples
                << ",\"frequencyBandLabels\":[\"invalid\",\"le0\",\"le2\",\"le5\",\"le10\","
                << "\"le15\",\"le30\",\"le60\",\"le100\",\"gt100\"]"
                << ",\"netUpdateFrequency\":[";
            for (size_t Index = 0; Index < Counters.NetUpdateFrequencyBands.size(); ++Index) {
                if (Index) Stream << ',';
                Stream << Counters.NetUpdateFrequencyBands[Index];
            }
            Stream << "],\"minNetUpdateFrequency\":[";
            for (size_t Index = 0; Index < Counters.MinNetUpdateFrequencyBands.size(); ++Index) {
                if (Index) Stream << ',';
                Stream << Counters.MinNetUpdateFrequencyBands[Index];
            }
            Stream << "],\"dormancyBandLabels\":[\"never\",\"awake\",\"dormantAll\","
                << "\"dormantPartial\",\"initial\",\"max\",\"invalid\"],\"dormancy\":[";
            for (size_t Index = 0; Index < Counters.NetDormancyBands.size(); ++Index) {
                if (Index) Stream << ',';
                Stream << Counters.NetDormancyBands[Index];
            }
            Stream << "],\"roleLabels\":[\"none\",\"simulatedProxy\",\"autonomousProxy\","
                << "\"authority\",\"maxOrInvalid\"],\"roleMatrix\":[";
            for (size_t Index = 0; Index < Counters.NetRoleMatrix.size(); ++Index) {
                if (Index) Stream << ',';
                Stream << Counters.NetRoleMatrix[Index];
            }
            Stream << "],\"owned\":" << Counters.OwnedActorSamples
                << ",\"replicatedMovement\":" << Counters.ReplicatedMovementSamples
                << ",\"critical\":" << Counters.CriticalActorSamples
                << ",\"immediate\":" << Counters.ImmediateActorSamples
                << ",\"netTemporary\":" << Counters.NetTemporarySamples
                << ",\"netStartup\":" << Counters.NetStartupSamples
                << ",\"netLoadOnClient\":" << Counters.NetLoadOnClientSamples
                << ",\"onlyRelevantToOwner\":"
                << Counters.OnlyRelevantToOwnerSamples
                << ",\"alwaysRelevant\":" << Counters.AlwaysRelevantSamples
                << ",\"ownerRelevancy\":" << Counters.OwnerRelevancySamples
                << ",\"tearOff\":" << Counters.TearOffSamples
                << ",\"excluded\":{\"notReplicated\":"
                << Counters.ExcludedNotReplicated
                << ",\"remoteRoleNone\":" << Counters.ExcludedRemoteRoleNone
                << ",\"localRoleNone\":" << Counters.ExcludedLocalRoleNone
                << ",\"unexpectedLocalRole\":" << Counters.UnexpectedLocalRole
                << ",\"destroying\":" << Counters.ExcludedDestroying
                << ",\"wrongWorld\":" << Counters.ExcludedWrongWorld << '}'
                << ",\"channelStateSamples\":" << Counters.ChannelStateSamples
                << ",\"channelOpenAcknowledged\":" << Counters.ChannelOpenAcknowledgedSamples
                << ",\"channelNotOpenAcknowledged\":"
                << Counters.ChannelNotOpenAcknowledgedSamples << '}';
        }

        void ResetInterval() {
            EngineTickDuration.Reset();
            FrameGap.Reset();
            NetworkingDuration.Reset();
            LongFrames50Ms = 0;
            LongFrames100Ms = 0;
            LongFrames250Ms = 0;
            IntervalStarted = std::chrono::steady_clock::now();
        }

        bool WriteAndFlush(const std::string& Buffer, uint64_t& BytesWritten, DWORD& Error) {
            BytesWritten = 0;
            Error = ERROR_SUCCESS;
            if (ProfileFile == INVALID_HANDLE_VALUE || Buffer.empty()) {
                Error = ERROR_INVALID_HANDLE;
                return false;
            }
            if (Buffer.size() > MaximumProfileBytes
                || TotalProfileBytesWritten > MaximumProfileBytes - Buffer.size()) {
                Error = ERROR_FILE_TOO_LARGE;
                return false;
            }

            size_t Offset = 0;
            while (Offset < Buffer.size()) {
                const DWORD Requested = static_cast<DWORD>((std::min)(
                    Buffer.size() - Offset, static_cast<size_t>(MAXDWORD)));
                DWORD Written = 0;
                if (!WriteFile(ProfileFile, Buffer.data() + Offset, Requested, &Written, nullptr) || Written == 0) {
                    Error = GetLastError();
                    return false;
                }
                Offset += Written;
                BytesWritten += Written;
            }

            if (!FlushFileBuffers(ProfileFile)) {
                Error = GetLastError();
                return false;
            }
            TotalProfileBytesWritten += BytesWritten;
            return true;
        }

        void WriteLifecycleRecords(std::ostream& Stream, const IntervalSnapshot& Snapshot) {
            for (size_t Index = 0; Index < Snapshot.LifecycleRecordCount; ++Index) {
                const LifecycleRecord& Record = Snapshot.LifecycleRecords[Index];
                Stream << "{\"type\":\"lifecycle\",\"timestamp\":\""
                    << FormatUtcTimestamp(Record.Timestamp, false)
                    << "\",\"pid\":" << GetCurrentProcessId()
                    << ",\"serverId\":\"" << JsonEscape(ServerId)
                    << "\",\"dllSha256\":\"" << JsonEscape(DllSha256)
                    << "\",\"event\":\"" << JsonEscape(Record.EventName.data()) << "\"";
                if (Record.FieldsJson[0]) Stream << ',' << Record.FieldsJson.data();
                Stream << "}\n";
            }
        }

        void WriteInterval(std::ostream& Output, const IntervalSnapshot& Snapshot) {
            const Networking::ProfilingCounters& NetworkingCounters = Snapshot.NetworkingCounters;
            const double EngineHz = Snapshot.ElapsedSeconds > 0.0
                ? Snapshot.EngineTickDuration.samples / Snapshot.ElapsedSeconds : 0.0;
            const double ActorSchedulerHz = Snapshot.ElapsedSeconds > 0.0
                ? NetworkingCounters.SchedulerTickCalls / Snapshot.ElapsedSeconds : 0.0;
            const double TransportDispatchHz = Snapshot.ElapsedSeconds > 0.0
                ? NetworkingCounters.NativeDispatchCalls / Snapshot.ElapsedSeconds : 0.0;
            const double TransportFlushHz = Snapshot.ElapsedSeconds > 0.0
                ? NetworkingCounters.NativeFlushCalls / Snapshot.ElapsedSeconds : 0.0;
            const double AverageConnections = NetworkingCounters.ConnectionSamples
                ? static_cast<double>(NetworkingCounters.ConnectionTotal) / NetworkingCounters.ConnectionSamples : 0.0;
            const double AverageLoadedWorldLatency = NetworkingCounters.LoadedWorldLatencySamples
                ? static_cast<double>(NetworkingCounters.LoadedWorldLatencyMilliseconds)
                    / NetworkingCounters.LoadedWorldLatencySamples : 0.0;
            const double AverageBootstrapLatency = NetworkingCounters.BootstrapLatencySamples
                ? static_cast<double>(NetworkingCounters.BootstrapLatencyMilliseconds)
                    / NetworkingCounters.BootstrapLatencySamples : 0.0;
            const auto AverageMicroseconds = [](uint64_t Total, uint64_t Samples) {
                return Samples ? static_cast<double>(Total) / Samples : 0.0;
            };

            Output << std::fixed << std::setprecision(3)
                << "{\"type\":\"interval\",\"profileSchemaVersion\":"
                << Networking::ProfileSchemaVersion
                << ",\"timestamp\":\"" << FormatUtcTimestamp(Snapshot.Timestamp, false)
                << "\",\"pid\":" << GetCurrentProcessId()
                << ",\"serverId\":\"" << JsonEscape(ServerId)
                << "\",\"dllSha256\":\"" << JsonEscape(DllSha256)
                << "\",\"configuredMaxFps\":" << ConfiguredMaxFps
                << ",\"observedMaxFps\":" << JsonNumber(Snapshot.ObservedMaxFps)
                << ",\"observedEngineHz\":" << EngineHz
                << ",\"observedActorSchedulerHz\":" << ActorSchedulerHz
                << ",\"observedTransportDispatchHz\":" << TransportDispatchHz
                << ",\"observedTransportFlushHz\":" << TransportFlushHz
                << ",\"engineTickMs\":";
            WriteHistogram(Output, Snapshot.EngineTickDuration);
            Output << ",\"frameGapMs\":";
            WriteHistogram(Output, Snapshot.FrameGap);
            Output << ",\"networkingMs\":";
            WriteHistogram(Output, Snapshot.NetworkingDuration);
            Output << ",\"pacing\":";
            WritePacing(Output, Snapshot.Pacing);
            Output << ",\"longFrames\":{\"over50Ms\":" << Snapshot.LongFrames50Ms
                << ",\"over100Ms\":" << Snapshot.LongFrames100Ms
                << ",\"over250Ms\":" << Snapshot.LongFrames250Ms << "}"
                << ",\"replication\":{\"attempts\":" << NetworkingCounters.ReplicationAttempts
                << ",\"successes\":" << NetworkingCounters.ReplicationSuccesses
                << ",\"ordinaryAttempts\":"
                << (NetworkingCounters.ReplicationAttempts - NetworkingCounters.BootstrapReplicationAttempts)
                << ",\"ordinarySuccesses\":"
                << (NetworkingCounters.ReplicationSuccesses - NetworkingCounters.BootstrapReplicationSuccesses)
                << ",\"bootstrapAttempts\":" << NetworkingCounters.BootstrapReplicationAttempts
                << ",\"bootstrapSuccesses\":" << NetworkingCounters.BootstrapReplicationSuccesses
                << ",\"preReplicationCalls\":"
                << NetworkingCounters.PreReplicationCalls
                << ",\"preReplicationUnavailable\":"
                << NetworkingCounters.PreReplicationUnavailable
                << ",\"preReplicationInvalidatedActors\":"
                << NetworkingCounters.PreReplicationInvalidatedActors
                << ",\"actorChannelsCreated\":" << NetworkingCounters.ActorChannelsCreated
                << ",\"actorChannelsReused\":" << NetworkingCounters.ActorChannelsReused
                << ",\"initialDelivery\":{\"pending\":"
                << NetworkingCounters.InitialDeliveryPending
                << ",\"attempted\":" << NetworkingCounters.InitialDeliveryAttempts
                << ",\"produced\":" << NetworkingCounters.InitialDeliveryProduced
                << ",\"acknowledged\":"
                << NetworkingCounters.InitialDeliveryAcknowledged
                << ",\"retried\":" << NetworkingCounters.InitialDeliveryRetries
                << ",\"budgetDeferred\":"
                << NetworkingCounters.InitialDeliveryBudgetDeferred << "}"
                << ",\"buckets\":{";
            for (size_t Index = 0; Index < ReplicationBucketNames.size(); ++Index) {
                if (Index) Output << ',';
                Output << '\"' << ReplicationBucketNames[Index] << "\":{\"attempts\":"
                    << NetworkingCounters.ReplicationAttemptsByBucket[Index]
                    << ",\"successes\":" << NetworkingCounters.ReplicationSuccessesByBucket[Index] << '}';
            }
            Output << "},\"urgentDamage\":{\"rpcMatches\":"
                << NetworkingCounters.UrgentDamageRpcMatches
                << ",\"interruptCorrelations\":"
                << NetworkingCounters.UrgentDamageInterruptCorrelations
                << ",\"invalidWeakHandles\":" << NetworkingCounters.UrgentDamageWeakHandlesInvalid
                << ",\"directBehemothTargets\":" << NetworkingCounters.UrgentDamageDirectBehemothTargets
                << ",\"ownerChainTargets\":" << NetworkingCounters.UrgentDamageOwnerChainTargets
                << ",\"targetsWithoutBehemoth\":" << NetworkingCounters.UrgentDamageTargetsWithoutBehemoth
                << ",\"queued\":" << NetworkingCounters.UrgentDamageTargetsQueued
                << ",\"deduplicated\":" << NetworkingCounters.UrgentDamageTargetsDeduplicated
                << ",\"dropped\":" << NetworkingCounters.UrgentDamageTargetsDropped
                << ",\"invalidated\":" << NetworkingCounters.UrgentDamageTargetsInvalidated
                << ",\"expired\":" << NetworkingCounters.UrgentDamageTargetsExpired
                << ",\"setupRetries\":" << NetworkingCounters.UrgentDamageSetupRetries
                << ",\"setupRetryExhausted\":"
                << NetworkingCounters.UrgentDamageSetupRetryExhausted
                << ",\"replicationAttempts\":" << NetworkingCounters.UrgentDamageReplicationAttempts
                << ",\"replicationSuccesses\":" << NetworkingCounters.UrgentDamageReplicationSuccesses
                << ",\"clientInterruptNotifications\":"
                << NetworkingCounters.BehemothInterruptClientNotifications
                << ",\"averageReceiveToPassMs\":" << AverageMicroseconds(
                    NetworkingCounters.UrgentDamageLatencyMilliseconds * 1000,
                    NetworkingCounters.UrgentDamageLatencySamples) / 1000.0 << "}"
                << ",\"urgentByReason\":{";
            for (size_t Index = 0; Index < UrgentReplicationReasonNames.size(); ++Index) {
                if (Index) Output << ',';
                Output << '\"' << UrgentReplicationReasonNames[Index] << "\":{"
                    << "\"queued\":" << NetworkingCounters.UrgentQueuedByReason[Index]
                    << ",\"deduplicated\":" << NetworkingCounters.UrgentDeduplicatedByReason[Index]
                    << ",\"dropped\":" << NetworkingCounters.UrgentDroppedByReason[Index]
                    << ",\"invalidated\":" << NetworkingCounters.UrgentInvalidatedByReason[Index]
                    << ",\"expired\":" << NetworkingCounters.UrgentExpiredByReason[Index]
                    << ",\"attempts\":" << NetworkingCounters.UrgentAttemptsByReason[Index]
                    << ",\"successes\":" << NetworkingCounters.UrgentSuccessesByReason[Index]
                    << ",\"latencySamples\":" << NetworkingCounters.UrgentLatencySamplesByReason[Index]
                    << ",\"averageLatencyMs\":" << AverageMicroseconds(
                        NetworkingCounters.UrgentLatencyMillisecondsByReason[Index] * 1000,
                        NetworkingCounters.UrgentLatencySamplesByReason[Index]) / 1000.0
                    << '}';
            }
            Output << "},\"criticalPrepass\":{"
                << "\"candidates\":" << NetworkingCounters.CriticalPrepassCandidates
                << ",\"attempts\":" << NetworkingCounters.CriticalPrepassAttempts
                << ",\"successes\":" << NetworkingCounters.CriticalPrepassSuccesses
                << ",\"duplicateSkips\":" << NetworkingCounters.CriticalPrepassDuplicateSkips
                << ",\"setupFallbacks\":" << NetworkingCounters.CriticalPrepassSetupFallbacks
                << ",\"ownedFrequencyLimited\":"
                << NetworkingCounters.CriticalOwnedFrequencyLimited << "}"
                << ",\"immediateActorPassStreakScope\":\"actor_engine_pass_across_connections\""
                << ",\"actorClasses\":[";
            bool WroteImmediateClass = false;
            for (const Networking::ImmediateClassCounters& ClassCounters : NetworkingCounters.ImmediateClasses) {
                if (ClassCounters.Attempts == 0 &&
                    ClassCounters.UntrackableOwnerCalls == 0 &&
                    ClassCounters.OwnerSensitiveDeferrals == 0 &&
                    ClassCounters.IrrelevantSkips == 0 &&
                    ClassCounters.InitialDeliveryPending == 0 &&
                    ClassCounters.InitialDeliveryAttempts == 0 &&
                    ClassCounters.InitialDeliveryProduced == 0 &&
                    ClassCounters.InitialDeliveryAcknowledged == 0 &&
                    ClassCounters.InitialDeliveryRetries == 0 &&
                    ClassCounters.InitialDeliveryBudgetDeferred == 0) continue;
                if (WroteImmediateClass) Output << ',';
                WroteImmediateClass = true;
                Output << "{\"class\":\"" << JsonEscape(ClassCounters.ClassName.data())
                    << "\",\"attempts\":" << ClassCounters.Attempts
                    << ",\"successes\":" << ClassCounters.Successes
                    << ",\"actorPasses\":" << ClassCounters.ActorPasses
                    << ",\"actorPassAttempts\":" << ClassCounters.ActorPassAttempts
                    << ",\"actorPassSuccesses\":" << ClassCounters.ActorPassSuccesses
                    << ",\"actorPassesWithAnyData\":" << ClassCounters.ActorPassesWithAnyData
                    << ",\"actorPassesWithNoData\":" << ClassCounters.ActorPassesWithNoData
                    << ",\"untrackableOwnerCalls\":" << ClassCounters.UntrackableOwnerCalls
                    << ",\"ownerSensitiveDeferrals\":" << ClassCounters.OwnerSensitiveDeferrals
                    << ",\"irrelevantSkips\":" << ClassCounters.IrrelevantSkips
                    << ",\"initialDelivery\":{\"pending\":"
                    << ClassCounters.InitialDeliveryPending
                    << ",\"attempted\":" << ClassCounters.InitialDeliveryAttempts
                    << ",\"produced\":" << ClassCounters.InitialDeliveryProduced
                    << ",\"acknowledged\":"
                    << ClassCounters.InitialDeliveryAcknowledged
                    << ",\"retried\":" << ClassCounters.InitialDeliveryRetries
                    << ",\"budgetDeferred\":"
                    << ClassCounters.InitialDeliveryBudgetDeferred << "}"
                    << ",\"immediateNoDataPassStreaks\":[";
                for (size_t Band = 0; Band < ClassCounters.NoDataPassStreaks.size(); ++Band) {
                    if (Band) Output << ',';
                    Output << ClassCounters.NoDataPassStreaks[Band];
                }
                Output << "]}";
            }
            Output << "],\"schedulerState\":{\"insertions\":"
                << NetworkingCounters.SchedulerStateInsertions
                << ",\"capacityDrops\":"
                << NetworkingCounters.SchedulerStateCapacityDrops
                << ",\"actorIdentityResets\":"
                << NetworkingCounters.SchedulerActorIdentityResets
                << ",\"ownerChanges\":"
                << NetworkingCounters.SchedulerOwnerChanges
                << ",\"prunes\":" << NetworkingCounters.SchedulerStatePrunes
                << ",\"current\":" << NetworkingCounters.CurrentSchedulerStates
                << ",\"maximum\":" << NetworkingCounters.MaximumSchedulerStates
                << "}}"
                << ",\"combatEvents\":{";
            for (size_t Index = 0; Index < CombatEventNames.size(); ++Index) {
                if (Index) Output << ',';
                Output << '\"' << CombatEventNames[Index] << "\":{\"calls\":"
                    << NetworkingCounters.CombatEventCalls[Index]
                    << ",\"successes\":" << NetworkingCounters.CombatEventSuccesses[Index] << '}';
            }
            Output << "},\"combatText\":{"
                << "\"queuedEntries\":" << NetworkingCounters.CombatTextEntries
                << ",\"queuedEstimatedBytes\":" << NetworkingCounters.CombatTextEstimatedBytes
                << ",\"multicastEntries\":" << NetworkingCounters.CombatTextMulticastEntries
                << ",\"multicastEstimatedBytes\":"
                << NetworkingCounters.CombatTextMulticastEstimatedBytes << "}"
                << ",\"actorProperties\":";
            WriteActorPropertyDistribution(Output, NetworkingCounters);
            Output << ",\"lastCompletedNetworkingPhase\":" << NetworkingCounters.LastCompletedPhase
                << ",\"hotPathTimingUs\":{\"cacheRebuildTotal\":"
                << NetworkingCounters.CacheRebuildMicroseconds
                << ",\"cacheRebuildSamples\":" << NetworkingCounters.CacheRebuildTimingSamples
                << ",\"cacheRebuildMean\":" << AverageMicroseconds(
                    NetworkingCounters.CacheRebuildMicroseconds, NetworkingCounters.CacheRebuildTimingSamples)
                << ",\"candidateSelectionTotal\":" << NetworkingCounters.CandidateSelectionMicroseconds
                << ",\"candidateSelectionSamples\":" << NetworkingCounters.CandidateSelectionTimingSamples
                << ",\"candidateSelectionMean\":" << AverageMicroseconds(
                    NetworkingCounters.CandidateSelectionMicroseconds, NetworkingCounters.CandidateSelectionTimingSamples)
                << ",\"channelScanTotal\":" << NetworkingCounters.ChannelScanMicroseconds
                << ",\"channelScanSamples\":" << NetworkingCounters.ChannelScanTimingSamples
                << ",\"channelScanMean\":" << AverageMicroseconds(
                    NetworkingCounters.ChannelScanMicroseconds, NetworkingCounters.ChannelScanTimingSamples)
                << ",\"replicationTotal\":" << NetworkingCounters.ReplicationMicroseconds
                << ",\"replicationSamples\":" << NetworkingCounters.ReplicationTimingSamples
                << ",\"replicationMean\":" << AverageMicroseconds(
                    NetworkingCounters.ReplicationMicroseconds, NetworkingCounters.ReplicationTimingSamples) << "}"
                << ",\"considerCache\":{\"rebuilds\":" << NetworkingCounters.CacheRebuilds
                << ",\"currentCandidates\":" << NetworkingCounters.CurrentCandidates
                << ",\"maximumCandidates\":" << NetworkingCounters.MaximumCandidates
                << ",\"reasonLabels\":[\"forced\",\"worldChanged\",\"worldIdentity\","
                << "\"maximumAge\",\"levelCount\",\"actorCount\"],\"byReason\":[";
            for (size_t Index = 0;
                Index < NetworkingCounters.CacheRebuildsByReason.size(); ++Index) {
                if (Index) Output << ',';
                Output << NetworkingCounters.CacheRebuildsByReason[Index];
            }
            const uint64_t NaturalCacheRebuilds =
                NetworkingCounters.CacheRebuildsByReason[3];
            Output << "],\"naturalRebuilds\":" << NaturalCacheRebuilds
                << ",\"forcedRebuilds\":"
                << (NetworkingCounters.CacheRebuilds - NaturalCacheRebuilds) << "}"
                << ",\"connectionBootstrap\":{\"loadedWorldAccepted\":" << NetworkingCounters.LoadedWorldAccepted
                << ",\"loadedWorldMismatched\":" << NetworkingCounters.LoadedWorldMismatched
                << ",\"possessionAcknowledged\":" << NetworkingCounters.PossessionAcknowledged
                << ",\"starts\":" << NetworkingCounters.BootstrapStarts
                << ",\"restarts\":" << NetworkingCounters.BootstrapRestarts
                << ",\"completed\":" << NetworkingCounters.BootstrapCompleted
                << ",\"deadlines\":" << NetworkingCounters.BootstrapDeadlines
                << ",\"criticalActorsDiscovered\":" << NetworkingCounters.CriticalActorsDiscovered
                << ",\"criticalChannelsAcknowledged\":" << NetworkingCounters.CriticalChannelsAcknowledged
                << ",\"averageLoadedWorldLatencyMs\":" << AverageLoadedWorldLatency
                << ",\"averageCompletionLatencyMs\":" << AverageBootstrapLatency
                << ",\"droppedLifecycleEvents\":"
                << (NetworkingCounters.DroppedLifecycleEvents + Snapshot.DroppedLifecycleRecords)
                << ",\"phases\":{\"bootstrapping\":" << NetworkingCounters.BootstrapPhaseConnections[0]
                << ",\"active\":" << NetworkingCounters.BootstrapPhaseConnections[1] << "}}"
                << ",\"abilityRpc\":{\"matched\":" << Snapshot.AbilityRpcMatched
                << ",\"activated\":" << Snapshot.AbilityRpcActivated
                << ",\"rejected\":" << Snapshot.AbilityRpcRejected
                << ",\"originalFallback\":" << Snapshot.AbilityRpcOriginalFallback << "}"
                << ",\"processEvent\":{\"calls\":" << Snapshot.ProcessEventCalls
                << ",\"netServerCandidates\":" << Snapshot.ProcessEventNetServerCandidates
                << ",\"nameLookups\":" << Snapshot.ProcessEventNameLookups
                << ",\"nameFallbacks\":" << Snapshot.ProcessEventNameFallbacks
                << ",\"functionMatches\":" << Snapshot.ProcessEventFunctionMatches
                << ",\"originalCalls\":" << Snapshot.ProcessEventOriginalCalls << "}"
                << ",\"connections\":{\"average\":" << AverageConnections
                << ",\"maximum\":" << NetworkingCounters.MaximumConnections
                << ",\"zeroConnectionTicks\":" << NetworkingCounters.ZeroConnectionTicks
                << ",\"trackedCurrent\":" << Snapshot.TrackedConnections
                << ",\"rawCurrent\":" << Snapshot.RawConnections << "}"
                << ",\"liveActorPolicy\":{\"eligible\":"
                << NetworkingCounters.LivePolicyEligible
                << ",\"due\":" << NetworkingCounters.LivePolicyDue
                << ",\"notDue\":" << NetworkingCounters.LivePolicyNotDue
                << ",\"relevant\":" << NetworkingCounters.LivePolicyRelevant
                << ",\"notRelevant\":" << NetworkingCounters.LivePolicyNotRelevant
                << ",\"dormantDeferrals\":"
                << NetworkingCounters.LivePolicyDormantDeferrals
                << ",\"driverMismatches\":"
                << NetworkingCounters.LivePolicyDriverMismatches
                << ",\"temporaryRetirements\":"
                << NetworkingCounters.LivePolicyTemporaryRetirements
                << ",\"tearOffRetirements\":"
                << NetworkingCounters.LivePolicyTearOffRetirements
                << ",\"identityFallbacks\":"
                << NetworkingCounters.LivePolicyIdentityFallbacks
                << ",\"actorIdentityFallbacks\":"
                << NetworkingCounters.LivePolicyActorIdentityFallbacks
                << ",\"connectionIdentityFallbacks\":"
                << NetworkingCounters.LivePolicyConnectionIdentityFallbacks
                << ",\"stateCapacityFallbacks\":"
                << NetworkingCounters.LivePolicyStateCapacityFallbacks
                << ",\"untrackableOwners\":"
                << NetworkingCounters.LivePolicyUntrackableOwners
                << ",\"ownerSensitiveDeferrals\":"
                << NetworkingCounters.LivePolicyOwnerSensitiveDeferrals
                << ",\"nativeRelevancyCalls\":"
                << NetworkingCounters.LivePolicyNativeRelevancyCalls
                << ",\"nativeRelevancyFallbacks\":"
                << NetworkingCounters.LivePolicyNativeRelevancyFallbacks
                << ",\"relevancyAudits\":"
                << NetworkingCounters.LivePolicyRelevancyAudits
                << ",\"relevancyRecheckSamples\":"
                << NetworkingCounters.LivePolicyRelevancyRecheckSamples
                << ",\"averageRelevancyRecheckMs\":" << AverageMicroseconds(
                    NetworkingCounters.LivePolicyRelevancyRecheckMilliseconds * 1000,
                    NetworkingCounters.LivePolicyRelevancyRecheckSamples) / 1000.0
                << ",\"irrelevantSkips\":"
                << NetworkingCounters.LivePolicyIrrelevantSkips
                << ",\"levelInitializationUnavailable\":"
                << NetworkingCounters.LivePolicyLevelInitializationUnavailable
                << ",\"prioritySorts\":"
                << NetworkingCounters.LivePolicyPrioritySorts
                << ",\"priorityCandidates\":"
                << NetworkingCounters.LivePolicyPriorityCandidates
                << ",\"priorityBandLabels\":[\"le1\",\"le10\",\"le100\","
                << "\"le1000\",\"gt1000\"],\"priorityBands\":[";
            for (size_t Index = 0;
                Index < NetworkingCounters.LivePolicyPriorityBands.size(); ++Index) {
                if (Index) Output << ',';
                Output << NetworkingCounters.LivePolicyPriorityBands[Index];
            }
            Output << "]"
                << ",\"movementPrepassAttempts\":"
                << NetworkingCounters.LivePolicyMovementPrepassAttempts
                << ",\"movementPrepassSuccesses\":"
                << NetworkingCounters.LivePolicyMovementPrepassSuccesses
                << ",\"criticalRejected\":"
                << NetworkingCounters.LivePolicyCriticalRejected
                << ",\"duplicateSkips\":"
                << NetworkingCounters.LivePolicyDuplicateSkips << "}"
                << ",\"nativeNetworking\":{\"dispatchCalls\":"
                << NetworkingCounters.NativeDispatchCalls
                << ",\"dispatchOwnershipValidBefore\":"
                << NetworkingCounters.NativeDispatchOwnershipValidBefore
                << ",\"dispatchOwnershipValidAfter\":"
                << NetworkingCounters.NativeDispatchOwnershipValidAfter
                << ",\"dispatchOwnershipLostInside\":"
                << NetworkingCounters.NativeDispatchOwnershipLostInside
                << ",\"flushCalls\":" << NetworkingCounters.NativeFlushCalls
                << ",\"flushOwnershipValidBefore\":"
                << NetworkingCounters.NativeFlushOwnershipValidBefore
                << ",\"flushOwnershipValidAfter\":"
                << NetworkingCounters.NativeFlushOwnershipValidAfter
                << ",\"flushOwnershipLostInside\":"
                << NetworkingCounters.NativeFlushOwnershipLostInside
                << ",\"ownershipMissingAfterEngineTick\":"
                << NetworkingCounters.NativeOwnershipMissingAfterEngineTick
                << ",\"reciprocalRepairs\":"
                << NetworkingCounters.NativeReciprocalRepairs
                << ",\"blockedDispatches\":"
                << NetworkingCounters.NativeDispatchBlocked
                << ",\"conflicts\":" << NetworkingCounters.NativeDispatchConflicts
                << ",\"postLogins\":" << NetworkingCounters.NativePostLogins
                << "}"
                << ",\"profileWriter\":{\"droppedSnapshots\":" << Snapshot.DroppedIntervalSnapshots
                << ",\"previousWriteFailures\":" << Snapshot.PreviousIntervalWriteFailures
                << ",\"previousWriteError\":" << Snapshot.PreviousIntervalWriteError
                << ",\"serializationCalls\":" << Snapshot.WriterSerializationCalls
                << ",\"serializationTotalUs\":" << Snapshot.WriterSerializationMicroseconds
                << ",\"serializationMaximumUs\":" << Snapshot.WriterSerializationMaximumMicroseconds
                << ",\"serializationMeanUs\":" << AverageMicroseconds(
                    Snapshot.WriterSerializationMicroseconds, Snapshot.WriterSerializationCalls)
                << ",\"writeFlushCalls\":" << Snapshot.WriterWriteFlushCalls
                << ",\"writeFlushTotalUs\":" << Snapshot.WriterWriteFlushMicroseconds
                << ",\"writeFlushMaximumUs\":" << Snapshot.WriterWriteFlushMaximumMicroseconds
                << ",\"writeFlushMeanUs\":" << AverageMicroseconds(
                    Snapshot.WriterWriteFlushMicroseconds, Snapshot.WriterWriteFlushCalls) << "}";

            const double CpuInterval100Nanoseconds =
                Snapshot.ElapsedSeconds * 10000000.0;
            const auto CpuPercent = [CpuInterval100Nanoseconds](
                uint64_t Cpu100Nanoseconds) {
                return CpuInterval100Nanoseconds > 0.0
                    ? static_cast<double>(Cpu100Nanoseconds) /
                        CpuInterval100Nanoseconds * 100.0
                    : 0.0;
            };
            Output << ",\"cpuAttribution\":{\"samplingError\":"
                << Snapshot.Cpu.SamplingError
                << ",\"gameThreadId\":" << Snapshot.Cpu.GameThreadId
                << ",\"processCpuMs\":"
                << static_cast<double>(
                    Snapshot.Cpu.ProcessCpu100Nanoseconds) / 10000.0
                << ",\"processPercentOfOneCore\":"
                << CpuPercent(Snapshot.Cpu.ProcessCpu100Nanoseconds)
                << ",\"gameThreadCpuMs\":"
                << static_cast<double>(
                    Snapshot.Cpu.GameThreadCpu100Nanoseconds) / 10000.0
                << ",\"gameThreadPercentOfOneCore\":"
                << CpuPercent(Snapshot.Cpu.GameThreadCpu100Nanoseconds)
                << ",\"topThreads\":[";
            for (size_t Index = 0;
                Index < Snapshot.Cpu.TopThreadCount; ++Index) {
                if (Index) Output << ',';
                const ThreadCpuEntry& Thread =
                    Snapshot.Cpu.TopThreads[Index];
                Output << "{\"id\":" << Thread.ThreadId
                    << ",\"cpuMs\":"
                    << static_cast<double>(Thread.Cpu100Nanoseconds) /
                        10000.0
                    << ",\"percentOfOneCore\":"
                    << CpuPercent(Thread.Cpu100Nanoseconds)
                    << ",\"description\":\""
                    << JsonEscape(Thread.Description.data()) << "\"}";
            }
            Output << "]}"
                << ",\"netDriver\":{\"netServerMaxTickRate\":" << Snapshot.NetServerMaxTickRate
                << ",\"maxNetTickRate\":" << Snapshot.MaxNetTickRate
                << ",\"maxClientRate\":" << Snapshot.MaxClientRate << "}}\n";
        }

        unsigned __stdcall WriterMain(void*) {
            for (;;) {
                const HANDLE Events[] = { StopEvent, PendingSnapshotEvent };
                const DWORD Result = WaitForMultipleObjects(2, Events, FALSE, INFINITE);
                if (Result != WAIT_OBJECT_0 && Result != WAIT_OBJECT_0 + 1) continue;
                const bool Stopping = Result == WAIT_OBJECT_0;

                AcquireSRWLockExclusive(&PendingSnapshotLock);
                if (!HasPendingSnapshot) {
                    ReleaseSRWLockExclusive(&PendingSnapshotLock);
                    if (Stopping) break;
                    continue;
                }
                WriterSnapshot = *PendingSnapshot;
                HasPendingSnapshot = false;
                ReleaseSRWLockExclusive(&PendingSnapshotLock);

                SampleThreadCpu(WriterSnapshot.Cpu);
                const auto SerializationStartedAt = std::chrono::steady_clock::now();
                std::ostringstream Output;
                WriteLifecycleRecords(Output, WriterSnapshot);
                WriteInterval(Output, WriterSnapshot);
                const std::string Buffer = Output.str();
                const uint64_t SerializationMicroseconds = ElapsedMicroseconds(SerializationStartedAt);
                WriterSerializationCalls.fetch_add(1, std::memory_order_relaxed);
                WriterSerializationMicroseconds.fetch_add(SerializationMicroseconds, std::memory_order_relaxed);
                AtomicMaximum(WriterSerializationMaximumMicroseconds, SerializationMicroseconds);

                uint64_t BytesWritten = 0;
                DWORD Error = ERROR_SUCCESS;
                const auto WriteStartedAt = std::chrono::steady_clock::now();
                if (WriteAndFlush(Buffer, BytesWritten, Error)) {
                    IntervalBytesWritten.fetch_add(BytesWritten, std::memory_order_relaxed);
                    LastIntervalWriteError.store(ERROR_SUCCESS, std::memory_order_relaxed);
                }
                else {
                    IntervalWriteFailures.fetch_add(1, std::memory_order_relaxed);
                    LastIntervalWriteError.store(Error, std::memory_order_relaxed);
                }
                const uint64_t WriteMicroseconds = ElapsedMicroseconds(WriteStartedAt);
                WriterWriteFlushCalls.fetch_add(1, std::memory_order_relaxed);
                WriterWriteFlushMicroseconds.fetch_add(WriteMicroseconds, std::memory_order_relaxed);
                AtomicMaximum(WriterWriteFlushMaximumMicroseconds, WriteMicroseconds);
                if (Stopping) break;
            }
            return 0;
        }

        bool PublishSnapshot(const IntervalSnapshot& Snapshot) {
            if (!TryAcquireSRWLockExclusive(&PendingSnapshotLock)) return false;
            if (HasPendingSnapshot) {
                ReleaseSRWLockExclusive(&PendingSnapshotLock);
                return false;
            }
            *PendingSnapshot = Snapshot;
            HasPendingSnapshot = true;
            ReleaseSRWLockExclusive(&PendingSnapshotLock);
            SetEvent(PendingSnapshotEvent);
            return true;
        }
    }

    void Configure(bool IsEnabled, uint32_t NewIntervalSeconds, const std::string& NewServerId,
        const std::string& NewMapPath, const std::wstring& NewOutputDirectory,
        uint64_t NewMaximumFileBytes) {
        ConfiguredEnabled = IsEnabled;
        ProfileOutputDirectory = NewOutputDirectory;
        Enabled = IsEnabled && !ProfileOutputDirectory.empty();
        TotalProfileBytesWritten = 0;
        IntervalSeconds = (std::clamp)(NewIntervalSeconds, 10u, 3600u);
        MaximumProfileBytes = (std::clamp)(
            NewMaximumFileBytes, 1024ull * 1024ull, 1024ull * 1024ull * 1024ull);
        ServerId = NewServerId;
        MapPath = NewMapPath;
        DllSha256 = ReadDllSha256Argument();
    }

    bool Start(const AssetOptimization::Metrics& Optimization) {
        if (!Enabled || Started) return Started;

        std::error_code DirectoryError;
        std::filesystem::create_directories(ProfileOutputDirectory, DirectoryError);
        if (DirectoryError) {
            StartupWriteError = DirectoryError.value();
            Enabled = false;
            return false;
        }

        if (!PendingSnapshot) {
            PendingSnapshot = new (std::nothrow) IntervalSnapshot{};
            if (!PendingSnapshot) {
                WriterStartError = ERROR_NOT_ENOUGH_MEMORY;
                Enabled = false;
                return false;
            }
        }

        ProfilePath = ProfileOutputDirectory
            / ("gameserver-perf-" + UtcTimestamp(true) + "-" + std::to_string(GetCurrentProcessId()) + ".jsonl");
        ProfileFile = CreateFileW(ProfilePath.c_str(), FILE_APPEND_DATA,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL, nullptr);
        if (ProfileFile == INVALID_HANDLE_VALUE) {
            StartupWriteError = GetLastError();
            Enabled = false;
            return false;
        }

        std::ostringstream Startup;
        Startup << "{\"type\":\"startup\",\"profileSchemaVersion\":"
            << Networking::ProfileSchemaVersion
            << ",\"timestamp\":\"" << UtcTimestamp(false)
            << "\",\"pid\":" << GetCurrentProcessId()
            << ",\"serverId\":\"" << JsonEscape(ServerId)
            << "\",\"map\":\"" << JsonEscape(MapPath)
            << "\",\"dllSha256\":\"" << JsonEscape(DllSha256)
            << "\",\"optimization\":" << AssetOptimization::MetricsJson(Optimization)
            << ",\"pacing\":";
        WritePacing(Startup, ServerPacing::GetSnapshot());
        Startup << "}\n";
        const std::string StartupBuffer = Startup.str();
        StartupWriteSucceeded = WriteAndFlush(StartupBuffer, StartupBytesWritten, StartupWriteError);

        LARGE_INTEGER FileSize{};
        if (StartupWriteSucceeded && (!GetFileSizeEx(ProfileFile, &FileSize) || FileSize.QuadPart <= 0)) {
            StartupWriteSucceeded = false;
            StartupWriteError = GetLastError();
            if (StartupWriteError == ERROR_SUCCESS) StartupWriteError = ERROR_WRITE_FAULT;
        }
        if (!StartupWriteSucceeded) {
            CloseHandle(ProfileFile);
            ProfileFile = INVALID_HANDLE_VALUE;
            Enabled = false;
            return false;
        }

        PendingSnapshotEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!PendingSnapshotEvent) {
            WriterStartError = GetLastError();
            CloseHandle(ProfileFile);
            ProfileFile = INVALID_HANDLE_VALUE;
            Enabled = false;
            return false;
        }

        StopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!StopEvent) {
            WriterStartError = GetLastError();
            CloseHandle(PendingSnapshotEvent);
            PendingSnapshotEvent = nullptr;
            CloseHandle(ProfileFile);
            ProfileFile = INVALID_HANDLE_VALUE;
            Enabled = false;
            return false;
        }

        const uintptr_t Thread = _beginthreadex(nullptr, 0, WriterMain, nullptr, 0, nullptr);
        if (Thread == 0) {
            WriterStartError = ERROR_NOT_ENOUGH_MEMORY;
            CloseHandle(StopEvent);
            StopEvent = nullptr;
            CloseHandle(PendingSnapshotEvent);
            PendingSnapshotEvent = nullptr;
            CloseHandle(ProfileFile);
            ProfileFile = INVALID_HANDLE_VALUE;
            Enabled = false;
            return false;
        }
        WriterThread = reinterpret_cast<HANDLE>(Thread);

        WriterStarted = true;
        Started = true;
        if (!ExitHandlerRegistered) {
            std::atexit(ServerPerformance::Stop);
            ExitHandlerRegistered = true;
        }
        ResetInterval();
        return true;
    }

    void Stop() {
        Started = false;
        if (StopEvent && WriterThread) {
            SetEvent(StopEvent);
            if (WaitForSingleObject(WriterThread, 10'000) != WAIT_OBJECT_0)
                return;
            CloseHandle(WriterThread);
            WriterThread = nullptr;
        }
        if (ProfileFile != INVALID_HANDLE_VALUE) {
            FlushFileBuffers(ProfileFile);
            CloseHandle(ProfileFile);
            ProfileFile = INVALID_HANDLE_VALUE;
        }
        if (PendingSnapshotEvent) {
            CloseHandle(PendingSnapshotEvent);
            PendingSnapshotEvent = nullptr;
        }
        if (StopEvent) {
            CloseHandle(StopEvent);
            StopEvent = nullptr;
        }
        delete PendingSnapshot;
        PendingSnapshot = nullptr;
        HasPendingSnapshot = false;
        WriterStarted = false;
        Enabled = false;
    }

    std::string StatusJson() {
        std::ostringstream Output;
        Output << "{\"enabled\":" << (ConfiguredEnabled ? "true" : "false")
            << ",\"started\":" << (Started ? "true" : "false")
            << ",\"startupWriteSucceeded\":" << (StartupWriteSucceeded ? "true" : "false")
            << ",\"writerStarted\":" << (WriterStarted ? "true" : "false")
            << ",\"maximumBytes\":" << MaximumProfileBytes
            << ",\"bytesWritten\":" << TotalProfileBytesWritten
            << ",\"path\":\"" << JsonEscape(WideToUtf8(ProfilePath.wstring()))
            << "\",\"startupBytes\":" << StartupBytesWritten
            << ",\"startupError\":" << StartupWriteError
            << ",\"writerError\":" << WriterStartError
            << ",\"intervalBytes\":" << IntervalBytesWritten.load(std::memory_order_relaxed)
            << ",\"intervalWriteFailures\":" << IntervalWriteFailures.load(std::memory_order_relaxed)
            << ",\"lastIntervalError\":" << LastIntervalWriteError.load(std::memory_order_relaxed)
            << ",\"writerSerializationMaximumUs\":"
            << WriterSerializationMaximumMicroseconds.load(std::memory_order_relaxed)
            << ",\"writerWriteFlushMaximumUs\":"
            << WriterWriteFlushMaximumMicroseconds.load(std::memory_order_relaxed)
            << ",\"dllSha256\":\"" << JsonEscape(DllSha256) << "\"}";
        return Output.str();
    }

    void RecordEngineTick(float DeltaSeconds, double OriginalTickMilliseconds) {
        if (!Started) return;
        DWORD ExpectedThreadId = 0;
        GameThreadId.compare_exchange_strong(
            ExpectedThreadId, GetCurrentThreadId(),
            std::memory_order_relaxed);
        const double GapMilliseconds = static_cast<double>(DeltaSeconds) * 1000.0;
        EngineTickDuration.Add(OriginalTickMilliseconds);
        FrameGap.Add(GapMilliseconds);
        if (GapMilliseconds > 50.0) ++LongFrames50Ms;
        if (GapMilliseconds > 100.0) ++LongFrames100Ms;
        if (GapMilliseconds > 250.0) ++LongFrames250Ms;
    }

    void RecordNetworking(double Milliseconds) {
        if (Started) NetworkingDuration.Add(Milliseconds);
    }

    void RecordProcessEvent(bool NetServerCandidate, bool OriginalCall) {
        if (!Started) return;
        ++ProcessEventCalls;
        if (NetServerCandidate) ++ProcessEventNetServerCandidates;
        if (OriginalCall) ++ProcessEventOriginalCalls;
    }

    void RecordProcessEventNameLookup(bool UsedFallback) {
        if (!Started) return;
        ++ProcessEventNameLookups;
        if (UsedFallback) ++ProcessEventNameFallbacks;
    }

    void RecordProcessEventFunctionMatch() {
        if (Started) ++ProcessEventFunctionMatches;
    }

    void RecordAbilityRpc(bool Activated, bool UsedOriginalFallback) {
        if (!Started) return;
        ++AbilityRpcMatched;
        if (Activated) ++AbilityRpcActivated;
        else ++AbilityRpcRejected;
        if (UsedOriginalFallback) ++AbilityRpcOriginalFallback;
    }

    std::string JsonString(const std::string& Value) {
        return "\"" + JsonEscape(Value) + "\"";
    }

    void RecordLifecycleEvent(const std::string& EventName, const std::string& FieldsJson) {
        if (!Started) return;
        if (PendingLifecycleRecordCount >= PendingLifecycleRecords.size()
            || EventName.size() >= LifecycleEventNameCapacity
            || FieldsJson.size() >= LifecycleFieldsCapacity) {
            ++DroppedLifecycleRecords;
            return;
        }

        LifecycleRecord& Record = PendingLifecycleRecords[PendingLifecycleRecordCount++];
        Record = {};
        GetSystemTime(&Record.Timestamp);
        std::memcpy(Record.EventName.data(), EventName.data(), EventName.size());
        if (!FieldsJson.empty())
            std::memcpy(Record.FieldsJson.data(), FieldsJson.data(), FieldsJson.size());
    }

    void Tick() {
        if (!Started) return;
        const auto Now = std::chrono::steady_clock::now();
        const double ElapsedSeconds = std::chrono::duration<double>(Now - IntervalStarted).count();
        if (ElapsedSeconds < IntervalSeconds) return;

        IntervalSnapshot& Snapshot = CaptureSnapshot;
        Snapshot = {};
        GetSystemTime(&Snapshot.Timestamp);
        Snapshot.ElapsedSeconds = ElapsedSeconds;
        Snapshot.ObservedMaxFps = UKismetSystemLibrary::GetConsoleVariableFloatValue(L"t.MaxFPS");
        Snapshot.EngineTickDuration = EngineTickDuration;
        Snapshot.FrameGap = FrameGap;
        Snapshot.NetworkingDuration = NetworkingDuration;
        Snapshot.LongFrames50Ms = LongFrames50Ms;
        Snapshot.LongFrames100Ms = LongFrames100Ms;
        Snapshot.LongFrames250Ms = LongFrames250Ms;
        Snapshot.AbilityRpcMatched = AbilityRpcMatched;
        Snapshot.AbilityRpcActivated = AbilityRpcActivated;
        Snapshot.AbilityRpcRejected = AbilityRpcRejected;
        Snapshot.AbilityRpcOriginalFallback = AbilityRpcOriginalFallback;
        Snapshot.ProcessEventCalls = ProcessEventCalls;
        Snapshot.ProcessEventNetServerCandidates = ProcessEventNetServerCandidates;
        Snapshot.ProcessEventNameLookups = ProcessEventNameLookups;
        Snapshot.ProcessEventNameFallbacks = ProcessEventNameFallbacks;
        Snapshot.ProcessEventFunctionMatches = ProcessEventFunctionMatches;
        Snapshot.ProcessEventOriginalCalls = ProcessEventOriginalCalls;
        Snapshot.DroppedLifecycleRecords = DroppedLifecycleRecords;
        Snapshot.DroppedIntervalSnapshots = DroppedIntervalSnapshots;
        Snapshot.PreviousIntervalWriteFailures = IntervalWriteFailures.load(std::memory_order_relaxed);
        Snapshot.PreviousIntervalWriteError = LastIntervalWriteError.load(std::memory_order_relaxed);
        Snapshot.WriterSerializationCalls = WriterSerializationCalls.load(std::memory_order_relaxed);
        Snapshot.WriterSerializationMicroseconds = WriterSerializationMicroseconds.load(std::memory_order_relaxed);
        Snapshot.WriterSerializationMaximumMicroseconds =
            WriterSerializationMaximumMicroseconds.load(std::memory_order_relaxed);
        Snapshot.WriterWriteFlushCalls = WriterWriteFlushCalls.load(std::memory_order_relaxed);
        Snapshot.WriterWriteFlushMicroseconds = WriterWriteFlushMicroseconds.load(std::memory_order_relaxed);
        Snapshot.WriterWriteFlushMaximumMicroseconds =
            WriterWriteFlushMaximumMicroseconds.load(std::memory_order_relaxed);
        Snapshot.NetworkingCounters = Networking::TakeProfilingCounters();
        Snapshot.Pacing = ServerPacing::GetSnapshot();
        Snapshot.LifecycleRecordCount = PendingLifecycleRecordCount;
        std::copy_n(PendingLifecycleRecords.begin(), PendingLifecycleRecordCount,
            Snapshot.LifecycleRecords.begin());

        UNetDriver* Driver = Networking::NetDriver;
        Snapshot.TrackedConnections = static_cast<uint32_t>(Networking::GetLiveConnections().size());
        Snapshot.RawConnections = Driver ? static_cast<uint32_t>((std::max)(0, Driver->ClientConnections.Num())) : 0;
        Snapshot.NetServerMaxTickRate = Driver ? Driver->NetServerMaxTickRate : 0;
        Snapshot.MaxNetTickRate = Driver ? Driver->MaxNetTickRate : 0;
        Snapshot.MaxClientRate = Driver ? Driver->MaxClientRate : 0;

        PendingLifecycleRecordCount = 0;
        AbilityRpcMatched = 0;
        AbilityRpcActivated = 0;
        AbilityRpcRejected = 0;
        AbilityRpcOriginalFallback = 0;
        ProcessEventCalls = 0;
        ProcessEventNetServerCandidates = 0;
        ProcessEventNameLookups = 0;
        ProcessEventNameFallbacks = 0;
        ProcessEventFunctionMatches = 0;
        ProcessEventOriginalCalls = 0;
        DroppedLifecycleRecords = 0;
        ResetInterval();

        if (PublishSnapshot(Snapshot)) {
            DroppedIntervalSnapshots = 0;
        }
        else {
            ++DroppedIntervalSnapshots;
            // The networking counters and lifecycle ring were already consumed into
            // this snapshot. Carry every lost record forward if the single writer
            // slot was occupied so the next successful interval reports the loss.
            DroppedLifecycleRecords += Snapshot.LifecycleRecordCount
                + Snapshot.DroppedLifecycleRecords
                + Snapshot.NetworkingCounters.DroppedLifecycleEvents;
        }
    }
}
