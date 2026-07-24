void* OrigProcessEvent = nullptr;

struct StableObjectIdentity {
    UObject* Object = nullptr;
    int32_t Index = -1;
    int32_t SerialNumber = 0;
};

static StableObjectIdentity TrackStableObject(UObject* Object) {
    if (!Object || !UObject::GObjects || Object->Index < 0)
        return {};
    FUObjectItem* Item = UObject::GObjects->GetItemByIndex(Object->Index);
    if (!Item || Item->Object != Object)
        return {};
    return { Object, Object->Index, Item->SerialNumber };
}

static UObject* ResolveStableObject(const StableObjectIdentity& Identity) {
    if (!Identity.Object || !UObject::GObjects || Identity.Index < 0)
        return nullptr;
    FUObjectItem* Item = UObject::GObjects->GetItemByIndex(Identity.Index);
    if (!Item || Item->Object != Identity.Object || Item->SerialNumber != Identity.SerialNumber ||
        (static_cast<uint32_t>(Item->Flags) & 0x30000000u) != 0)
        return nullptr;
    UObject* Object = Item->Object;
    if ((Object->Flags & EObjectFlags::BeginDestroyed) ||
        (Object->Flags & EObjectFlags::FinishDestroyed))
        return nullptr;
    return Object;
}

static AActor* FindStableOwningActor(UObject* Object) {
    UObject* Current = Object;
    for (uint8_t Depth = 0; Current && Depth < 8; ++Depth) {
        const StableObjectIdentity Identity = TrackStableObject(Current);
        if (ResolveStableObject(Identity) != Current)
            return nullptr;
        if (Current->IsA(AActor::StaticClass()))
            return static_cast<AActor*>(Current);
        Current = Current->Outer;
    }
    return nullptr;
}

static bool HasPlayerCharacterOwner(AActor* Actor) {
    AActor* Current = Actor;
    for (uint8_t Depth = 0; Current && Depth < 8; ++Depth) {
        const StableObjectIdentity Identity = TrackStableObject(Current);
        if (ResolveStableObject(Identity) != Current)
            return false;
        if (Current->IsA(AArchonCharacter::StaticClass()))
            return true;
        AActor* Next = Current->Owner;
        if (!Next && Current->Instigator)
            Next = Current->Instigator;
        if (Next == Current)
            return false;
        Current = Next;
    }
    return false;
}
