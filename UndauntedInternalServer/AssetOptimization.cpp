#include "AssetOptimization.h"

#include <Windows.h>
#include <Psapi.h>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
#include <vector>

#include "SDK.hpp"

#pragma comment(lib, "psapi.lib")

using namespace SDK;

namespace AssetOptimization {
    namespace {
        constexpr uint32_t PublicKeepFlags = static_cast<uint32_t>(EObjectFlags::Standalone) |
            static_cast<uint32_t>(EObjectFlags::MarkAsRootSet);
        constexpr uint32_t InternalRootSet = 0x40000000u;
        constexpr uintptr_t CollectGarbageRva = 0x01ED4750;
        constexpr uintptr_t InitialLoadFlagRva = 0x0597166C;
        constexpr uint8_t ExpectedCollectGarbagePrologue[] = {
            0x48, 0x89, 0x5C, 0x24, 0x08, 0x57, 0x48, 0x83, 0xEC, 0x20,
            0x0F, 0xB6, 0xDA, 0x8B, 0xF9
        };

        struct ProcessMemory {
            uint64_t workingSet = 0;
            uint64_t privateBytes = 0;
        };

        enum class Outcome {
            Retained,
            Collected,
            DestroyPending,
            SlotReused,
            Aborted
        };

        struct Candidate {
            int32_t index = -1;
            UObject* object = nullptr;
            int32_t serialNumber = 0;
            uint32_t publicFlags = 0;
            uint32_t internalFlags = 0;
            std::string fullName;
            std::string className;
            std::string packageName;
            Outcome outcome = Outcome::Retained;
            std::string reason = "report_only";
        };

        struct PackageSelection {
            std::unordered_set<std::string> protectedPackages;
            std::unordered_set<std::string> inactiveMapPackages;
        };

        ProcessMemory ReadProcessMemory() {
            PROCESS_MEMORY_COUNTERS_EX Counters{};
            Counters.cb = sizeof(Counters);
            if (!GetProcessMemoryInfo(GetCurrentProcess(),
                reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&Counters), sizeof(Counters))) {
                return {};
            }
            return { static_cast<uint64_t>(Counters.WorkingSetSize), static_cast<uint64_t>(Counters.PrivateUsage) };
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

        std::string BytesToHex(const uint8_t* Bytes, size_t Length) {
            std::ostringstream Output;
            Output << std::uppercase << std::hex << std::setfill('0');
            for (size_t Index = 0; Index < Length; ++Index) {
                if (Index != 0) Output << ' ';
                Output << std::setw(2) << static_cast<unsigned int>(Bytes[Index]);
            }
            return Output.str();
        }

        std::string UtcTimestamp(bool FilenameSafe) {
            SYSTEMTIME Time{};
            GetSystemTime(&Time);
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

        std::filesystem::path ExecutableDirectory() {
            std::wstring Buffer(32768, L'\0');
            const DWORD Length = GetModuleFileNameW(nullptr, Buffer.data(), static_cast<DWORD>(Buffer.size()));
            if (Length == 0 || Length >= Buffer.size()) return std::filesystem::current_path();
            Buffer.resize(Length);
            return std::filesystem::path(Buffer).parent_path();
        }

        std::string GetOutermostName(UObject* Object) {
            UObject* Outermost = Object;
            while (Outermost && Outermost->Outer) Outermost = Outermost->Outer;
            return Outermost ? Outermost->GetName() : std::string();
        }

        void ProtectObjectPackage(UObject* Object, PackageSelection& Selection) {
            if (!Object) return;
            const std::string PackageName = GetOutermostName(Object);
            if (!PackageName.empty()) Selection.protectedPackages.insert(PackageName);
        }

        bool IsApexDestructionObject(UObject* Object) {
            return Object && (Object->IsA(ADestructibleActor::StaticClass()) ||
                Object->IsA(UDestructibleComponent::StaticClass()) ||
                Object->IsA(UDestructibleMesh::StaticClass()) ||
                Object->IsA(UDestructibleFractureSettings::StaticClass()));
        }

        PackageSelection FindPackages(const std::string& MapContext) {
            PackageSelection Selection;
            UWorld* World = UWorld::GetWorld();
            if (World) {
                ProtectObjectPackage(World, Selection);
                ProtectObjectPackage(World->PersistentLevel, Selection);
                ProtectObjectPackage(World->CurrentLevelPendingVisibility, Selection);
                ProtectObjectPackage(World->CurrentLevelPendingInvisibility, Selection);
                for (ULevel* Level : World->Levels) ProtectObjectPackage(Level, Selection);
                for (ULevelStreaming* Streaming : World->StreamingLevels) {
                    ProtectObjectPackage(Streaming, Selection);
                    if (Streaming) {
                        ProtectObjectPackage(Streaming->LoadedLevel, Selection);
                        ProtectObjectPackage(Streaming->PendingUnloadLevel, Selection);
                    }
                }
            }

            // APEX destructible actors retain native asset/actor state outside UE's
            // reflected reference graph. Clearing the keep flags from one of their
            // packages can let GC release the native asset before a later actor
            // teardown, which crashes Apex_Destructible while reading its asset
            // table. Keep every package participating in a destructible lifetime.
            for (int32_t Index = 0; Index < UObject::GObjects->Num(); ++Index) {
                UObject* Object = UObject::GObjects->GetByIndex(Index);
                if (IsApexDestructionObject(Object)) ProtectObjectPackage(Object, Selection);
            }

            for (int32_t Index = 0; Index < UObject::GObjects->Num(); ++Index) {
                UObject* Object = UObject::GObjects->GetByIndex(Index);
                if (!Object || Object->IsDefaultObject() ||
                    (!Object->IsA(UWorld::StaticClass()) && !Object->IsA(ULevel::StaticClass()))) {
                    continue;
                }
                const std::string PackageName = GetOutermostName(Object);
                if (PackageName.empty() || PackageName == "Engine" || PackageName == "CoreUObject" || PackageName == "Transient") {
                    continue;
                }
                if (!Selection.protectedPackages.contains(PackageName)) Selection.inactiveMapPackages.insert(PackageName);
            }

            // The configured map may be represented by a package object before every level pointer settles.
            if (!MapContext.empty()) {
                for (auto It = Selection.inactiveMapPackages.begin(); It != Selection.inactiveMapPackages.end();) {
                    if (MapContext.find(*It) != std::string::npos || It->find(MapContext) != std::string::npos) {
                        Selection.protectedPackages.insert(*It);
                        It = Selection.inactiveMapPackages.erase(It);
                    }
                    else {
                        ++It;
                    }
                }
            }
            return Selection;
        }

        uint64_t CountLiveObjects() {
            uint64_t Count = 0;
            for (int32_t Index = 0; Index < UObject::GObjects->Num(); ++Index) {
                if (UObject::GObjects->GetByIndex(Index)) ++Count;
            }
            return Count;
        }

        bool VerifyCollectGarbageSignature(Metrics& Result) {
            const auto Address = reinterpret_cast<const uint8_t*>(GetModuleHandleW(nullptr)) + CollectGarbageRva;
            Result.expectedGcSignature = BytesToHex(ExpectedCollectGarbagePrologue, std::size(ExpectedCollectGarbagePrologue));
            Result.observedGcSignature = BytesToHex(Address, std::size(ExpectedCollectGarbagePrologue));
            Result.signatureValid = std::equal(std::begin(ExpectedCollectGarbagePrologue),
                std::end(ExpectedCollectGarbagePrologue), Address);
            return Result.signatureValid;
        }

        bool IsDestroying(UObject* Object) {
            return Object && ((Object->Flags & EObjectFlags::BeginDestroyed) ||
                (Object->Flags & EObjectFlags::FinishDestroyed));
        }

        bool IsSameCandidateObject(const FUObjectItem* CurrentItem, const Candidate& Item) {
            if (!CurrentItem || CurrentItem->Object != Item.object)
                return false;

            // A zero serial means this object had not needed a weak identity yet.
            // UE may assign one during a GC callback without replacing the object.
            // Pointer plus object-array slot still identify that survivor; once a
            // serial existed, require it exactly so slot reuse cannot be mistaken
            // for the original object.
            return Item.serialNumber == 0 ||
                CurrentItem->SerialNumber == Item.serialNumber;
        }

        void RestoreSurvivingFlags(Candidate& Item) {
            FUObjectItem* CurrentItem = UObject::GObjects->GetItemByIndex(Item.index);
            if (!IsSameCandidateObject(CurrentItem, Item) || IsDestroying(Item.object)) {
                return;
            }

            // GC may legitimately change reachability, destruction, cluster,
            // and async bookkeeping. Restore only the keep bits deliberately
            // cleared by this optimization.
            const uint32_t CurrentPublic = static_cast<uint32_t>(Item.object->Flags);
            Item.object->Flags = static_cast<EObjectFlags>(
                CurrentPublic | (Item.publicFlags & PublicKeepFlags));
            const uint32_t CurrentInternal = static_cast<uint32_t>(CurrentItem->Flags);
            CurrentItem->Flags = static_cast<int32_t>(
                CurrentInternal | (Item.internalFlags & InternalRootSet));
        }

        void RestoreAfterFailure(std::vector<Candidate>& Candidates, Metrics& Result, const std::string& Reason) {
            Result.collected = 0;
            Result.retained = 0;
            for (Candidate& Item : Candidates) {
                FUObjectItem* CurrentItem = UObject::GObjects->GetItemByIndex(Item.index);
                if (!IsSameCandidateObject(CurrentItem, Item) || IsDestroying(Item.object)) {
                    Item.outcome = Outcome::Collected;
                    Item.reason = "not_surviving_after_" + Reason;
                    ++Result.collected;
                    continue;
                }
                RestoreSurvivingFlags(Item);
                Item.outcome = Outcome::Aborted;
                Item.reason = Reason;
                ++Result.retained;
            }
        }

        const char* OutcomeName(Outcome Value) {
            switch (Value) {
            case Outcome::Collected: return "collected";
            case Outcome::DestroyPending: return "destroy_pending";
            case Outcome::SlotReused: return "slot_reused";
            case Outcome::Aborted: return "aborted";
            default: return "retained";
            }
        }

        void WriteManifest(const std::vector<Candidate>& Candidates, const std::string& MapContext, Metrics& Result) {
            const std::filesystem::path Directory = ExecutableDirectory();
            const std::string Stem = "asset-strip-" + UtcTimestamp(true) + "-" + std::to_string(GetCurrentProcessId());
            const std::filesystem::path FinalPath = Directory / (Stem + ".jsonl");
            const std::filesystem::path TemporaryPath = Directory / (Stem + ".jsonl.tmp");
            std::ofstream Output(TemporaryPath, std::ios::out | std::ios::trunc);
            if (!Output.is_open()) return;

            Output << "{\"type\":\"header\",\"timestamp\":\"" << UtcTimestamp(false)
                << "\",\"mode\":\"" << ModeName(Result.mode) << "\",\"map\":\"" << JsonEscape(MapContext)
                << "\",\"candidates\":" << Result.candidates << "}\n";
            for (const Candidate& Item : Candidates) {
                Output << "{\"type\":\"asset\",\"index\":" << Item.index
                    << ",\"class\":\"" << JsonEscape(Item.className)
                    << "\",\"name\":\"" << JsonEscape(Item.fullName)
                    << "\",\"package\":\"" << JsonEscape(Item.packageName)
                    << "\",\"outcome\":\"" << OutcomeName(Item.outcome)
                    << "\",\"reason\":\"" << JsonEscape(Item.reason) << "\"}\n";
            }
            Output << "{\"type\":\"summary\",\"metrics\":" << MetricsJson(Result) << "}\n";
            Output.flush();
            if (!Output.good()) {
                Output.close();
                DeleteFileW(TemporaryPath.c_str());
                return;
            }
            Output.close();
            if (MoveFileExW(TemporaryPath.c_str(), FinalPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                Result.manifestWritten = true;
                Result.manifestPath = FinalPath.string();
            }
            else {
                DeleteFileW(TemporaryPath.c_str());
            }
        }
    }

    Mode ParseMode(const std::wstring& Value) {
        if (Value == L"off") return Mode::Off;
        if (Value == L"report") return Mode::Report;
        if (Value == L"safe") return Mode::Safe;
        if (Value == L"aggressive") return Mode::Aggressive;
        return Mode::Aggressive;
    }

    const char* ModeName(Mode Value) {
        switch (Value) {
        case Mode::Report: return "report";
        case Mode::Safe: return "safe";
        case Mode::Aggressive: return "aggressive";
        default: return "off";
        }
    }

    const char* SafetyGateName(SafetyGate Value) {
        switch (Value) {
        case SafetyGate::Passed: return "passed";
        case SafetyGate::InitialLoad: return "initial_load";
        case SafetyGate::ConnectionsPresent: return "connections_present";
        case SafetyGate::Timeout: return "timeout";
        case SafetyGate::SignatureMismatch: return "signature_mismatch";
        case SafetyGate::Failed: return "failed";
        default: return "not_required";
        }
    }

    bool IsInitialLoadComplete() {
        const auto Flag = reinterpret_cast<const uint8_t*>(GetModuleHandleW(nullptr)) + InitialLoadFlagRva;
        return *Flag == 0;
    }

    Metrics MakeSkipped(Mode ModeValue, SafetyGate Gate, const std::string& Reason) {
        Metrics Result{};
        Result.mode = ModeValue;
        Result.safetyGate = Gate;
        Result.failed = Gate != SafetyGate::NotRequired;
        Result.error = Reason;
        return Result;
    }

    Metrics Run(Mode ModeValue, bool StripInactiveMapPackages, bool LogDetails, const std::string& MapContext) {
        Metrics Result{};
        Result.mode = ModeValue;
        Result.safetyGate = ModeValue == Mode::Off || ModeValue == Mode::Report
            ? SafetyGate::NotRequired : SafetyGate::Passed;
        const auto StartedAt = std::chrono::steady_clock::now();
        const ProcessMemory Before = ReadProcessMemory();
        Result.workingSetBefore = Before.workingSet;
        Result.privateBytesBefore = Before.privateBytes;
        std::vector<Candidate> Candidates;

        if (ModeValue == Mode::Off) {
            Result.durationMs = 0;
            Result.workingSetAfter = Before.workingSet;
            Result.privateBytesAfter = Before.privateBytes;
            return Result;
        }

        if (ModeValue != Mode::Report && !VerifyCollectGarbageSignature(Result)) {
            Result.safetyGate = SafetyGate::SignatureMismatch;
            Result.failed = true;
            Result.error = "CollectGarbage(uint32,bool) signature mismatch; cleanup skipped";
            Result.workingSetAfter = Before.workingSet;
            Result.privateBytesAfter = Before.privateBytes;
            return Result;
        }

        Result.objectCountBefore = CountLiveObjects();
        try {
            const PackageSelection Packages = FindPackages(MapContext);
            Result.activeMapPackages = Packages.protectedPackages.size();
            Result.inactiveMapPackages = Packages.inactiveMapPackages.size();
            Candidates.reserve(4096);

            for (int32_t Index = 0; Index < UObject::GObjects->Num(); ++Index) {
                FUObjectItem* ObjectItem = UObject::GObjects->GetItemByIndex(Index);
                UObject* Object = ObjectItem ? ObjectItem->Object : nullptr;
                if (!Object || Object->IsDefaultObject() || IsDestroying(Object)) continue;

                const std::string PackageName = GetOutermostName(Object);
                if (Packages.protectedPackages.contains(PackageName)) continue;

                const bool IsTexture = Object->IsA(UTexture::StaticClass());
                const bool IsMaterial = Object->IsA(UMaterialInterface::StaticClass());
                const bool IsSound = Object->IsA(USoundBase::StaticClass());
                const bool IsInactiveMapObject = StripInactiveMapPackages &&
                    Packages.inactiveMapPackages.contains(PackageName);
                const bool IsAggressive = ModeValue == Mode::Aggressive || ModeValue == Mode::Report;
                const bool IsCandidate = IsTexture || IsMaterial || (IsAggressive && (IsSound || IsInactiveMapObject));
                if (!IsCandidate || IsApexDestructionObject(Object)) continue;

                if (IsTexture) ++Result.textures;
                if (IsMaterial) ++Result.materials;
                if (IsSound) ++Result.sounds;
                if (IsInactiveMapObject) ++Result.mapPackageCandidates;
                Candidates.push_back({
                    Index,
                    Object,
                    ObjectItem->SerialNumber,
                    static_cast<uint32_t>(Object->Flags),
                    static_cast<uint32_t>(ObjectItem->Flags),
                    LogDetails ? Object->GetFullName() : std::string(),
                    LogDetails && Object->Class ? Object->Class->GetName() : std::string(),
                    LogDetails ? PackageName : std::string()
                });
            }
            Result.candidates = Candidates.size();

            if (ModeValue == Mode::Report) {
                Result.retained = Result.candidates;
            }
            else {
                for (Candidate& Item : Candidates) {
                    FUObjectItem* CurrentItem = UObject::GObjects->GetItemByIndex(Item.index);
                    if (!IsSameCandidateObject(CurrentItem, Item) || IsDestroying(Item.object)) continue;
                    Item.object->Flags = static_cast<EObjectFlags>(static_cast<uint32_t>(Item.object->Flags) & ~PublicKeepFlags);
                    CurrentItem->Flags = static_cast<int32_t>(static_cast<uint32_t>(CurrentItem->Flags) & ~InternalRootSet);
                }

                using CollectGarbage = void(*)(uint32_t, bool);
                reinterpret_cast<CollectGarbage>(reinterpret_cast<uint8_t*>(GetModuleHandleW(nullptr)) + CollectGarbageRva)(0, true);

                for (Candidate& Item : Candidates) {
                    FUObjectItem* CurrentItem = UObject::GObjects->GetItemByIndex(Item.index);
                    if (!CurrentItem || !CurrentItem->Object) {
                        Item.outcome = Outcome::Collected;
                        Item.reason = "object_slot_cleared";
                        ++Result.collected;
                    }
                    else if (!IsSameCandidateObject(CurrentItem, Item)) {
                        Item.outcome = Outcome::SlotReused;
                        Item.reason = "object_slot_reused";
                        ++Result.collected;
                    }
                    else if (IsDestroying(Item.object)) {
                        Item.outcome = Outcome::DestroyPending;
                        Item.reason = "destruction_started";
                        ++Result.collected;
                    }
                    else {
                        RestoreSurvivingFlags(Item);
                        Item.outcome = Outcome::Retained;
                        Item.reason = "still_referenced_flags_restored";
                        ++Result.retained;
                    }
                }
            }
        }
        catch (const std::exception& Error) {
            RestoreAfterFailure(Candidates, Result, "gc_failed");
            Result.safetyGate = SafetyGate::Failed;
            Result.failed = true;
            Result.error = Error.what();
        }
        catch (...) {
            RestoreAfterFailure(Candidates, Result, "gc_failed");
            Result.safetyGate = SafetyGate::Failed;
            Result.failed = true;
            Result.error = "unknown asset cleanup failure";
        }

        Result.objectCountAfter = CountLiveObjects();
        const ProcessMemory After = ReadProcessMemory();
        Result.workingSetAfter = After.workingSet;
        Result.privateBytesAfter = After.privateBytes;
        Result.durationMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - StartedAt).count());
        if (LogDetails) WriteManifest(Candidates, MapContext, Result);
        return Result;
    }

    std::string MetricsJson(const Metrics& Value) {
        std::ostringstream Json;
        Json << "{\"mode\":\"" << ModeName(Value.mode)
            << "\",\"safetyGate\":\"" << SafetyGateName(Value.safetyGate)
            << "\",\"signatureValid\":" << (Value.signatureValid ? "true" : "false")
            << ",\"candidates\":" << Value.candidates
            << ",\"collected\":" << Value.collected
            << ",\"retained\":" << Value.retained
            << ",\"textures\":" << Value.textures
            << ",\"materials\":" << Value.materials
            << ",\"sounds\":" << Value.sounds
            << ",\"mapPackageCandidates\":" << Value.mapPackageCandidates
            << ",\"activeMapPackages\":" << Value.activeMapPackages
            << ",\"inactiveMapPackages\":" << Value.inactiveMapPackages
            << ",\"durationMs\":" << Value.durationMs
            << ",\"workingSetBefore\":" << Value.workingSetBefore
            << ",\"workingSetAfter\":" << Value.workingSetAfter
            << ",\"privateBytesBefore\":" << Value.privateBytesBefore
            << ",\"privateBytesAfter\":" << Value.privateBytesAfter
            << ",\"configuredMaxFps\":" << Value.configuredMaxFps
            << ",\"observedMaxFps\":" << Value.observedMaxFps
            << ",\"capSignatureValid\":" << (Value.capSignatureValid ? "true" : "false")
            << ",\"capResolved\":" << (Value.capResolved ? "true" : "false")
            << ",\"capApplied\":" << (Value.capApplied ? "true" : "false")
            << ",\"capVerified\":" << (Value.capVerified ? "true" : "false")
            << ",\"preReadyNetworkingPasses\":" << Value.preReadyNetworkingPasses
            << ",\"netServerMaxTickRate\":" << Value.netServerMaxTickRate
            << ",\"maxNetTickRate\":" << Value.maxNetTickRate
            << ",\"bootstrapMinimumMilliseconds\":" << Value.bootstrapMinimumMilliseconds
            << ",\"bootstrapMaximumMilliseconds\":" << Value.bootstrapMaximumMilliseconds
            << ",\"considerCacheMaxAgeMilliseconds\":" << Value.considerCacheMaxAgeMilliseconds
            << ",\"profilingEnabled\":" << (Value.profilingEnabled ? "true" : "false")
            << ",\"failed\":" << (Value.failed ? "true" : "false");
        if (!Value.manifestPath.empty()) Json << ",\"manifestPath\":\"" << JsonEscape(Value.manifestPath) << "\"";
        if (!Value.error.empty()) Json << ",\"error\":\"" << JsonEscape(Value.error) << "\"";
        Json << "}";
        return Json.str();
    }
}
