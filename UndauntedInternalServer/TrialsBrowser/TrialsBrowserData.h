#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <windows.h>

namespace TrialsBrowserOverlay {
    enum class BehemothElement : uint8_t {
        Neutral,
        Shock,
        Radiant,
        Umbral,
        Blaze,
        Frost,
        Terra,
    };

    enum class ModifierId : uint8_t {
        SelfRevive,
        ZeroSelfRevive,
        Nearsight,
        IcyGrasp,
        Shielded,
        Fortifications,
        Electrify,
        Aftershock,
        FrostSmollusks,
        Combustion,
        Whiteout,
        FrigidTouch,
        StaticShock,
        Inferno,
        UmbralInstability,
        ToughHide,
        ShockSmollusks,
        SovereignsChosen,
        Jagged,
        StyxianSacrifice,
        RadiantSmollusks,
        FlamingTail,
        Momentum,
        Fury,
        BehemothBlitz,
        VolcanicVitriol,
        CursedLightning,
        DeepFreeze,
        HotSpot,
        WeakSpot,
        LightningStars,
        BleedoutVines,
        UmbralStars,
        SplittingUmbral,
        UmbralSmollusks,
        IcyGrave,
        ViciousVigor,
        ThickSkull,
        IncandescentIncarceration,
        BlazeSmollusks,
        Shockfall,
        LeafShield,
        DangerZones,
        Bombers,
        TrackingLightning,
    };

    struct ModifierStyle {
        COLORREF Fill;
        COLORREF Border;
        COLORREF Text;
        COLORREF Accent;
    };

    enum class ModifierStyleId : uint8_t {
        Red,
        Nearsight,
        Frost,
        Shock,
        Shield,
        Object,
        Blaze,
        Umbral,
        Terra,
        Radiant,
        Behemoth,
        Arena,
    };

    struct ModifierDef {
        ModifierId Id;
        const wchar_t* Name;
        const wchar_t* Description;
        ModifierStyleId Style;
    };

    struct ModifierChip {
        const wchar_t* Text = L"";
        const wchar_t* Description = L"";
        ModifierStyle Style = {};
    };

    struct TrialRow {
        const char* Suffix;
        const wchar_t* Behemoth;
        BehemothElement Element;
        const wchar_t* Ids;
        int Level;
        int Power;
        const wchar_t* Atmosphere;
        uint64_t Modifiers;
    };

    struct TrialRowList {
        const TrialRow* Rows;
        int Count;
    };

    struct TrialDetails {
        std::wstring Behemoth;
        BehemothElement Element = BehemothElement::Neutral;
        std::wstring Ids;
        std::wstring ThreatPower;
        std::wstring Atmosphere;
        std::vector<ModifierChip> Modifiers;
    };

    TrialRowList TrialRowsForDifficulty(int DifficultyIndex);
    std::wstring TrialComboLabel(const TrialRow& Row);
    TrialDetails BuildTrialDetails(const TrialRow& Row);
    ModifierStyle ModifierStyleFor(ModifierStyleId Style);
    COLORREF BehemothColor(BehemothElement Element, bool Selected = false);
}
