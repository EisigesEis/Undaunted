#pragma once

#include <Windows.h>
#include <array>
#include <string>
#include <vector>
#include "../SDK.hpp"

using namespace SDK;

namespace Networking {
	using LifecycleEventSink = void(*)(const std::string& eventName,
		const std::string& fieldsJson);

	constexpr size_t ReplicationBucketCount = 6;
	constexpr size_t ConnectionBootstrapPhaseCount = 2;
	constexpr size_t ImmediateMetricTrackedClassCount = 256;
	constexpr size_t ImmediateMetricClassSlotCount = ImmediateMetricTrackedClassCount + 2;
	constexpr size_t ImmediateNoDataBandCount = 6;
	constexpr size_t ImmediateMetricClassNameCapacity = 64;
	constexpr size_t NetFrequencyBandCount = 10;
	constexpr size_t NetDormancyBandCount = 7;
	constexpr size_t NetRoleCount = 5;
	constexpr size_t NetRoleMatrixCount = NetRoleCount * NetRoleCount;
	constexpr size_t PriorityBandCount = 5;
	constexpr size_t CacheRebuildReasonCount = 6;
	constexpr uint32_t ProfileSchemaVersion = 2;

	enum class UrgentReplicationReason : uint8_t {
		Stagger,
		Bleedout,
		Revive,
		Dodge,
		Count
	};
	constexpr size_t UrgentReplicationReasonCount =
		static_cast<size_t>(UrgentReplicationReason::Count);

	enum class CombatEvent : uint8_t {
		BleedoutStarted,
		ReviveCompleted,
		ReviveQuickItem,
		DodgeRequested,
		DodgePerformed,
		ComboStarted,
		ComboNextMove,
		ComboStateChanged,
		ClientTryHit,
		ServerAcceptHit,
		ServerRefuseHit,
		ProcessHitOnServer,
		CombatTextQueued,
		CombatTextMulticast,
		StaggerConfirmed,
		Count
	};
	constexpr size_t CombatEventCount = static_cast<size_t>(CombatEvent::Count);

	struct ImmediateClassCounters {
		std::array<char, ImmediateMetricClassNameCapacity> ClassName{};
		uint64_t Attempts = 0;
		uint64_t Successes = 0;
		uint64_t ActorPasses = 0;
		uint64_t ActorPassAttempts = 0;
		uint64_t ActorPassSuccesses = 0;
		uint64_t ActorPassesWithAnyData = 0;
		uint64_t ActorPassesWithNoData = 0;
		std::array<uint64_t, ImmediateNoDataBandCount> NoDataPassStreaks{};
		uint64_t UntrackableOwnerCalls = 0;
		uint64_t OwnerSensitiveDeferrals = 0;
		uint64_t IrrelevantSkips = 0;
	};

	struct ProfilingCounters {
		uint64_t SchedulerTickCalls = 0;
		uint64_t ReplicationAttempts = 0;
		uint64_t ReplicationSuccesses = 0;
		uint64_t PreReplicationCalls = 0;
		uint64_t PreReplicationUnavailable = 0;
		uint64_t PreReplicationInvalidatedActors = 0;
		uint64_t BootstrapReplicationAttempts = 0;
		uint64_t BootstrapReplicationSuccesses = 0;
		uint64_t UrgentDamageRpcMatches = 0;
		uint64_t UrgentDamageInterruptCorrelations = 0;
		uint64_t UrgentDamageWeakHandlesInvalid = 0;
		uint64_t UrgentDamageDirectBehemothTargets = 0;
		uint64_t UrgentDamageOwnerChainTargets = 0;
		uint64_t UrgentDamageTargetsWithoutBehemoth = 0;
		uint64_t UrgentDamageTargetsQueued = 0;
		uint64_t UrgentDamageTargetsDeduplicated = 0;
		uint64_t UrgentDamageTargetsDropped = 0;
		uint64_t UrgentDamageTargetsInvalidated = 0;
		uint64_t UrgentDamageTargetsExpired = 0;
		uint64_t UrgentDamageSetupRetries = 0;
		uint64_t UrgentDamageSetupRetryExhausted = 0;
		uint64_t UrgentDamageReplicationAttempts = 0;
		uint64_t UrgentDamageReplicationSuccesses = 0;
		uint64_t UrgentDamageLatencyMilliseconds = 0;
		uint64_t UrgentDamageLatencySamples = 0;
		uint64_t BehemothInterruptClientNotifications = 0;
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentQueuedByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentDeduplicatedByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentDroppedByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentInvalidatedByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentExpiredByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentAttemptsByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentSuccessesByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentLatencyMillisecondsByReason{};
		std::array<uint64_t, UrgentReplicationReasonCount> UrgentLatencySamplesByReason{};
		uint64_t CriticalPrepassCandidates = 0;
		uint64_t CriticalPrepassAttempts = 0;
		uint64_t CriticalPrepassSuccesses = 0;
		uint64_t CriticalPrepassDuplicateSkips = 0;
		uint64_t CriticalPrepassSetupFallbacks = 0;
		uint64_t CriticalOwnedFrequencyLimited = 0;
		std::array<uint64_t, CombatEventCount> CombatEventCalls{};
		std::array<uint64_t, CombatEventCount> CombatEventSuccesses{};
		uint64_t CombatTextEntries = 0;
		uint64_t CombatTextEstimatedBytes = 0;
		uint64_t CombatTextMulticastEntries = 0;
		uint64_t CombatTextMulticastEstimatedBytes = 0;
		std::array<uint64_t, ReplicationBucketCount> ReplicationAttemptsByBucket{};
		std::array<uint64_t, ReplicationBucketCount> ReplicationSuccessesByBucket{};
		std::array<ImmediateClassCounters, ImmediateMetricClassSlotCount> ImmediateClasses{};
		std::array<uint32_t, ConnectionBootstrapPhaseCount> BootstrapPhaseConnections{};
		uint64_t CacheRebuilds = 0;
		std::array<uint64_t, CacheRebuildReasonCount> CacheRebuildsByReason{};
		uint64_t CacheRebuildMicroseconds = 0;
		uint64_t CacheRebuildTimingSamples = 0;
		uint64_t CandidateSelectionMicroseconds = 0;
		uint64_t CandidateSelectionTimingSamples = 0;
		uint64_t ChannelScanMicroseconds = 0;
		uint64_t ChannelScanTimingSamples = 0;
		uint64_t ReplicationMicroseconds = 0;
		uint64_t ReplicationTimingSamples = 0;
		uint64_t ZeroConnectionTicks = 0;
		uint64_t ConnectionSamples = 0;
		uint64_t ConnectionTotal = 0;
		uint64_t NativeDispatchCalls = 0;
		uint64_t NativeDispatchOwnershipValidBefore = 0;
		uint64_t NativeDispatchOwnershipValidAfter = 0;
		uint64_t NativeDispatchOwnershipLostInside = 0;
		uint64_t NativeFlushCalls = 0;
		uint64_t NativeFlushOwnershipValidBefore = 0;
		uint64_t NativeFlushOwnershipValidAfter = 0;
		uint64_t NativeFlushOwnershipLostInside = 0;
		uint64_t NativeOwnershipMissingAfterEngineTick = 0;
		uint64_t NativeReciprocalRepairs = 0;
		uint64_t NativeDispatchBlocked = 0;
		uint64_t NativeDispatchConflicts = 0;
		uint64_t NativePostLogins = 0;
		uint64_t LoadedWorldAccepted = 0;
		uint64_t LoadedWorldMismatched = 0;
		uint64_t PossessionAcknowledged = 0;
		uint64_t BootstrapStarts = 0;
		uint64_t BootstrapRestarts = 0;
		uint64_t BootstrapCompleted = 0;
		uint64_t BootstrapDeadlines = 0;
		uint64_t CriticalActorsDiscovered = 0;
		uint64_t CriticalChannelsAcknowledged = 0;
		uint64_t ActorChannelsCreated = 0;
		uint64_t ActorChannelsReused = 0;
		uint64_t ActorPropertySamples = 0;
		std::array<uint64_t, NetFrequencyBandCount> NetUpdateFrequencyBands{};
		std::array<uint64_t, NetFrequencyBandCount> MinNetUpdateFrequencyBands{};
		std::array<uint64_t, NetDormancyBandCount> NetDormancyBands{};
		std::array<uint64_t, NetRoleMatrixCount> NetRoleMatrix{};
		uint64_t OwnedActorSamples = 0;
		uint64_t ReplicatedMovementSamples = 0;
		uint64_t CriticalActorSamples = 0;
		uint64_t ImmediateActorSamples = 0;
		uint64_t NetTemporarySamples = 0;
		uint64_t NetStartupSamples = 0;
		uint64_t NetLoadOnClientSamples = 0;
		uint64_t OnlyRelevantToOwnerSamples = 0;
		uint64_t AlwaysRelevantSamples = 0;
		uint64_t OwnerRelevancySamples = 0;
		uint64_t TearOffSamples = 0;
		uint64_t ExcludedNotReplicated = 0;
		uint64_t ExcludedRemoteRoleNone = 0;
		uint64_t ExcludedLocalRoleNone = 0;
		uint64_t UnexpectedLocalRole = 0;
		uint64_t ExcludedDestroying = 0;
		uint64_t ExcludedWrongWorld = 0;
		uint64_t ChannelStateSamples = 0;
		uint64_t ChannelOpenAcknowledgedSamples = 0;
		uint64_t ChannelNotOpenAcknowledgedSamples = 0;
		uint64_t LivePolicyEligible = 0;
		uint64_t LivePolicyDue = 0;
		uint64_t LivePolicyNotDue = 0;
		uint64_t LivePolicyRelevant = 0;
		uint64_t LivePolicyNotRelevant = 0;
		uint64_t LivePolicyDormantDeferrals = 0;
		uint64_t LivePolicyDriverMismatches = 0;
		uint64_t LivePolicyTemporaryRetirements = 0;
		uint64_t LivePolicyTearOffRetirements = 0;
		uint64_t LivePolicyIdentityFallbacks = 0;
		uint64_t LivePolicyActorIdentityFallbacks = 0;
		uint64_t LivePolicyConnectionIdentityFallbacks = 0;
		uint64_t LivePolicyStateCapacityFallbacks = 0;
		uint64_t LivePolicyUntrackableOwners = 0;
		uint64_t LivePolicyOwnerSensitiveDeferrals = 0;
		uint64_t LivePolicyNativeRelevancyCalls = 0;
		uint64_t LivePolicyNativeRelevancyFallbacks = 0;
		uint64_t LivePolicyRelevancyAudits = 0;
		uint64_t LivePolicyRelevancyRecheckMilliseconds = 0;
		uint64_t LivePolicyRelevancyRecheckSamples = 0;
		uint64_t LivePolicyIrrelevantSkips = 0;
		uint64_t LivePolicyLevelInitializationUnavailable = 0;
		uint64_t LivePolicyPrioritySorts = 0;
		uint64_t LivePolicyPriorityCandidates = 0;
		std::array<uint64_t, PriorityBandCount> LivePolicyPriorityBands{};
		uint64_t LivePolicyMovementPrepassAttempts = 0;
		uint64_t LivePolicyMovementPrepassSuccesses = 0;
		uint64_t LivePolicyCriticalRejected = 0;
		uint64_t LivePolicyDuplicateSkips = 0;
		uint64_t SchedulerStateInsertions = 0;
		uint64_t SchedulerStateCapacityDrops = 0;
		uint64_t SchedulerActorIdentityResets = 0;
		uint64_t SchedulerOwnerChanges = 0;
		uint64_t SchedulerStatePrunes = 0;
		uint64_t LoadedWorldLatencyMilliseconds = 0;
		uint64_t LoadedWorldLatencySamples = 0;
		uint64_t BootstrapLatencyMilliseconds = 0;
		uint64_t BootstrapLatencySamples = 0;
		uint64_t DroppedLifecycleEvents = 0;
		uint32_t MaximumConnections = 0;
		uint32_t CurrentCandidates = 0;
		uint32_t MaximumCandidates = 0;
		uint32_t CurrentSchedulerStates = 0;
		uint32_t MaximumSchedulerStates = 0;
		uint32_t LastCompletedPhase = 0;
	};

	extern UNetDriver* NetDriver;

	void Configure(uint32_t considerCacheMaxAgeMilliseconds);
	void ConfigureLifecycleEventSink(LifecycleEventSink sink);
	void BeginFrameNetworkLifecycle(UWorld* World);
	void EndFrameNetworkLifecycle(UWorld* World);
	void ResetWorldState(UWorld* World);
	void ResetDriverState(UNetDriver* Driver);

	// Compatibility overloads keep the networking category independently
	// buildable before the later engine-integration patch is applied.
	bool Listen(UEngine* Engine, int Port);
	bool Listen(UEngine* Engine, UWorld* World, int Port);
	const std::string& GetLastListenError();

	void TickNetworking();
	void TickNetworking(UWorld* World);
	// Called immediately before the native UIpNetDriver transport dispatch pass.
	// Synthetic startup can briefly leave only one side of the UWorld/NetDriver
	// ownership pair populated; this restores a coherent pair before packets are
	// allowed to reach FNetworkNotify.
	bool PrepareNativeNetworkDispatch(UNetDriver* Driver);
	void NotifyNativeNetworkDispatchCompleted(UNetDriver* Driver);
	bool PrepareNativeNetworkFlush(UNetDriver* Driver);
	void NotifyNativeNetworkFlushCompleted(UNetDriver* Driver);
	void NotifyNativeEngineTickCompleted(UWorld* World);
	void NotifyNativePostLogin(APlayerController* PlayerController);
	void NotifyClientLoadedWorld(APlayerController* PlayerController, FName WorldPackageName);
	void NotifyClientAcknowledgedPawn(APlayerController* PlayerController, APawn* Pawn);
	void NotifyDamageRpcObserved();
	void NotifyUrgentDamageTarget(int32_t objectIndex, int32_t objectSerialNumber);
	void NotifyBehemothInterruptClientRpc();
	void QueueUrgentActor(AActor* actor, UrgentReplicationReason reason,
		APlayerController* targetController = nullptr);
	void RecordCombatEvent(CombatEvent event, bool succeeded = false, uint32_t amount = 1);
	void RecordCombatTextQueue(const FArchonMultitypeCombatTextEntry& entry);
	void RecordCombatTextMulticast(uint32_t entryCount);

	const std::vector<UNetConnection*>& GetLiveConnections();

	ProfilingCounters TakeProfilingCounters();
}
