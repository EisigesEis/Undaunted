#include "TrialsBrowserData.h"

#include <array>
#include <cwchar>

namespace TrialsBrowserOverlay {
    namespace {
        using E = BehemothElement;
        using M = ModifierId;
        using S = ModifierStyleId;

        constexpr uint64_t Bit(M Id) {
            return 1ull << static_cast<uint8_t>(Id);
        }

#define MODS(...) (__VA_ARGS__)
#define B(Name) Bit(M::Name)
#define ROW(Suffix, Name, Element, Ids, Lvl, Pwr, Atmosphere, Mods) { Suffix, L##Name, E::Element, L##Ids, Lvl, Pwr, Atmosphere, Mods }

        constexpr TrialRow NormalTrials[] = {
            ROW("001", "Shockjaw Nayzaga", Shock, "001, 014, 027, 040", 18, 600, nullptr, MODS(B(SelfRevive) | B(Nearsight) | B(Shielded) | B(Fortifications) | B(Electrify))),
            ROW("002", "Shrowd", Umbral, "002, 015, 028, 041, 082", 18, 600, nullptr, MODS(B(SelfRevive) | B(FrostSmollusks) | B(Combustion))),
            ROW("003", "Deadeye Quillshot", Neutral, "003, 016, 029, 042, 062, 087", 18, 600, nullptr, MODS(B(SelfRevive) | B(Whiteout) | B(FrigidTouch))),
            ROW("004", "Bloodfire Embermane", Blaze, "004, 017, 030, 047, 064, 088", 18, 600, nullptr, MODS(B(SelfRevive) | B(StaticShock) | B(Electrify) | B(Inferno))),
            ROW("005", "Winterhorn Skraev", Frost, "005, 018, 031, 048, 065, 080", 18, 600, nullptr, MODS(B(SelfRevive) | B(UmbralInstability) | B(ToughHide))),
            ROW("006", "Razorwing Kharabak", Terra, "006, 019, 032, 050, 067, 081", 18, 600, nullptr, MODS(B(SelfRevive) | B(ShockSmollusks) | B(SovereignsChosen) | B(Jagged))),
            ROW("007", "Koshai", Terra, "007, 020, 033, 051, 068, 083", 18, 600, nullptr, MODS(B(SelfRevive) | B(StyxianSacrifice))),
            ROW("008", "Rezakiri", Radiant, "008, 021, 034, 053, 070", 18, 600, nullptr, MODS(B(SelfRevive) | B(RadiantSmollusks) | B(FlamingTail))),
            ROW("009", "Firebrand Charrogg", Blaze, "009, 022, 035, 054, 072", 18, 600, nullptr, MODS(B(SelfRevive) | B(Whiteout) | B(Inferno))),
            ROW("010", "Moonreaver Shrike", Neutral, "010, 023, 036, 056, 073", 18, 600, nullptr, MODS(B(SelfRevive) | B(StyxianSacrifice) | B(Momentum))),
            ROW("011", "Rockfall Skarn", Terra, "011, 024, 037, 057, 074", 18, 600, nullptr, MODS(B(SelfRevive) | B(VolcanicVitriol) | B(BehemothBlitz))),
            ROW("012", "Frostback Pangar", Frost, "012, 025, 038, 075", 18, 600, nullptr, MODS(B(SelfRevive) | B(CursedLightning) | B(Electrify))),
            ROW("013", "Ragetail Gnasher", Neutral, "013, 026, 039, 060, 077", 18, 600, nullptr, MODS(B(SelfRevive) | B(StaticShock) | B(Jagged) | B(Fury))),
            ROW("043", "Malkarion", Shock, "043, 049, 066, 085", 18, 600, nullptr, MODS(B(SelfRevive) | B(DeepFreeze))),
            ROW("044", "Tempestborne Stormclaw", Shock, "044, 052, 069, 079", 18, 600, nullptr, MODS(B(SelfRevive) | B(HotSpot) | B(Fortifications) | B(StyxianSacrifice))),
            ROW("045", "Dreadfrost Boreus", Frost, "045, 055, 071", 18, 600, nullptr, MODS(B(SelfRevive) | B(WeakSpot) | B(LightningStars))),
            ROW("046", "Drask", Shock, "046, 059, 076", 18, 600, nullptr, MODS(B(SelfRevive) | B(BehemothBlitz) | B(ThickSkull) | B(StaticShock))),
            ROW("058", "Shadowtouched Koshai", Umbral, "058, 086", 18, 600, nullptr, MODS(B(SelfRevive) | B(BleedoutVines) | B(UmbralStars))),
            ROW("061", "Shadowtouched Nayzaga", Umbral, "061, 078", 18, 600, nullptr, MODS(B(SelfRevive) | B(BehemothBlitz) | B(DangerZones))),
            ROW("063", "Shadowtouched Drask", Umbral, "063, 084", 18, 600, nullptr, MODS(B(SelfRevive) | B(SplittingUmbral) | B(UmbralSmollusks))),
        };

        constexpr TrialRow DauntlessTrials[] = {
            ROW("001", "Shockjaw Nayzaga", Shock, "001, 014, 027, 040", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(Nearsight) | B(IcyGrasp) | B(Shielded) | B(Fortifications) | B(Electrify) | B(Aftershock))),
            ROW("002", "Shrowd", Umbral, "002, 015, 028, 041, 082", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(FrostSmollusks) | B(Inferno) | B(Combustion) | B(Fortifications))),
            ROW("003", "Deadeye Quillshot", Neutral, "003, 016, 029, 042, 062, 087", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(Whiteout) | B(IcyGrasp) | B(DeepFreeze) | B(FrigidTouch))),
            ROW("004", "Bloodfire Embermane", Blaze, "004, 017, 030, 047, 064, 088", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(StaticShock) | B(CursedLightning) | B(Electrify) | B(Inferno))),
            ROW("005", "Winterhorn Skraev", Frost, "005, 018, 031, 048, 065, 080", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(UmbralInstability) | B(ToughHide) | B(Momentum) | B(IcyGrave))),
            ROW("006", "Razorwing Kharabak", Terra, "006, 019, 032, 050, 067, 081", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(ShockSmollusks) | B(SovereignsChosen) | B(Jagged) | B(ToughHide))),
            ROW("007", "Koshai", Terra, "007, 020, 033, 051, 068, 083", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(StyxianSacrifice) | B(Fortifications) | B(ViciousVigor) | B(ThickSkull))),
            ROW("008", "Rezakiri", Radiant, "008", 22, 700, L"Arena Night", MODS(B(ZeroSelfRevive) | B(RadiantSmollusks) | B(IncandescentIncarceration) | B(Aftershock) | B(FlamingTail) | B(Inferno))),
            ROW("009", "Firebrand Charrogg", Blaze, "009, 022, 035, 054, 072", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(Whiteout) | B(BlazeSmollusks) | B(Inferno) | B(BehemothBlitz) | B(ThickSkull))),
            ROW("010", "Moonreaver Shrike", Neutral, "010, 023, 036, 056, 073", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(StyxianSacrifice) | B(Nearsight) | B(Momentum) | B(FrigidTouch))),
            ROW("011", "Rockfall Skarn", Terra, "011, 024, 037, 057, 074", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(VolcanicVitriol) | B(BehemothBlitz) | B(Combustion) | B(Inferno) | B(Shockfall))),
            ROW("012", "Frostback Pangar", Frost, "012, 025, 038, 075", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(CursedLightning) | B(Electrify) | B(DeepFreeze) | B(ThickSkull))),
            ROW("013", "Ragetail Gnasher", Neutral, "013, 026, 039, 060, 077", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(StaticShock) | B(LeafShield) | B(Jagged) | B(Fury))),
            ROW("021", "Rezakiri", Radiant, "021, 034, 053, 070", 22, 700, L"Night", MODS(B(ZeroSelfRevive) | B(RadiantSmollusks) | B(IncandescentIncarceration) | B(Aftershock) | B(FlamingTail) | B(Inferno))),
            ROW("043", "Malkarion", Shock, "043, 049, 066, 085", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(BehemothBlitz) | B(DeepFreeze) | B(DangerZones))),
            ROW("044", "Tempestborne Stormclaw", Shock, "044, 052, 069, 079", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(HotSpot) | B(Fortifications) | B(StyxianSacrifice) | B(Combustion))),
            ROW("045", "Dreadfrost Boreus", Frost, "045, 055, 071", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(WeakSpot) | B(LightningStars) | B(Electrify) | B(Bombers))),
            ROW("046", "Drask", Shock, "046, 059, 076", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(BehemothBlitz) | B(ThickSkull) | B(StaticShock) | B(TrackingLightning) | B(FrigidTouch))),
            ROW("058", "Shadowtouched Koshai", Umbral, "058, 086", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(Fortifications) | B(BleedoutVines) | B(Momentum) | B(UmbralStars))),
            ROW("061", "Shadowtouched Nayzaga", Umbral, "061, 078", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(BehemothBlitz) | B(DangerZones) | B(Combustion) | B(Inferno))),
            ROW("063", "Shadowtouched Drask", Umbral, "063, 084", 22, 700, nullptr, MODS(B(ZeroSelfRevive) | B(BehemothBlitz) | B(UmbralInstability) | B(SplittingUmbral) | B(UmbralSmollusks) | B(Electrify))),
        };

#undef ROW
#undef B
#undef MODS

        constexpr ModifierStyle ModifierStyles[] = {
            { RGB(72, 30, 35), RGB(207, 62, 70), RGB(255, 225, 226), RGB(255, 50, 58) },
            { RGB(37, 43, 52), RGB(104, 121, 140), RGB(221, 231, 238), RGB(133, 157, 181) },
            { RGB(24, 58, 80), RGB(78, 172, 220), RGB(222, 248, 255), RGB(57, 199, 255) },
            { RGB(48, 50, 35), RGB(210, 190, 72), RGB(255, 247, 195), RGB(255, 221, 54) },
            { RGB(48, 55, 62), RGB(171, 191, 198), RGB(241, 247, 244), RGB(225, 213, 118) },
            { RGB(65, 50, 35), RGB(196, 142, 76), RGB(250, 231, 206), RGB(230, 154, 54) },
            { RGB(77, 39, 27), RGB(218, 93, 45), RGB(255, 227, 207), RGB(255, 101, 34) },
            { RGB(52, 36, 69), RGB(143, 91, 188), RGB(238, 220, 255), RGB(176, 91, 255) },
            { RGB(35, 61, 42), RGB(93, 160, 92), RGB(222, 246, 215), RGB(111, 214, 94) },
            { RGB(67, 62, 43), RGB(218, 205, 128), RGB(255, 250, 224), RGB(255, 238, 129) },
            { RGB(61, 49, 39), RGB(166, 128, 86), RGB(246, 232, 213), RGB(213, 151, 78) },
            { RGB(39, 57, 65), RGB(91, 142, 164), RGB(220, 240, 246), RGB(89, 184, 216) },
        };

        constexpr COLORREF BehemothColors[][2] = {
            { RGB(176, 184, 192), RGB(232, 236, 240) },
            { RGB(245, 207, 67), RGB(255, 239, 138) },
            { RGB(234, 232, 211), RGB(255, 255, 245) },
            { RGB(178, 108, 220), RGB(226, 185, 255) },
            { RGB(238, 104, 51), RGB(255, 190, 140) },
            { RGB(91, 187, 228), RGB(191, 235, 255) },
            { RGB(118, 198, 104), RGB(198, 239, 180) },
        };

        constexpr ModifierDef Modifiers[] = {
            { M::ZeroSelfRevive, L"One Chance", L"Slayers do not have any self-revives.", S::Red },
            { M::SelfRevive, L"Last Stand", L"Slayers have one self-revive.", S::Red },
            { M::Nearsight, L"Nearsight", L"Slayers' vision will become shrouded by a cloud of umbral aether.", S::Nearsight },
            { M::IcyGrasp, L"Icy Grasp", L"Behemoths have been touched by frost energy and will periodically cause icy spikes to erupt.", S::Frost },
            { M::Shielded, L"Shielded", L"Objects created by Behemoths are temporarily electrified, shocking players who attack them.", S::Shield },
            { M::Fortifications, L"Fortifications", L"Objects created by Behemoths have increased health.", S::Object },
            { M::Electrify, L"Electrify", L"Behemoths' physical attacks shock Slayers.", S::Shock },
            { M::Aftershock, L"Aftershock", L"Behemoth slam attacks cause targeted shockwaves.", S::Shock },
            { M::FrostSmollusks, L"Frost Smollusks", L"Frost smollusks inhabit the area and leave trails of dangerous frost slime wherever they travel. Standing in frost slime will freeze the Slayer.", S::Frost },
            { M::Combustion, L"Combustion", L"Behemoths' physical attacks set Slayers on fire.", S::Blaze },
            { M::Whiteout, L"Whiteout", L"An icy gale whips up blizzards on the battlefield that obscure visibility. Destroy the ice globes to end the blizzards.", S::Frost },
            { M::FrigidTouch, L"Frigid Touch", L"Behemoth physical attacks apply Chilled to Slayers.", S::Frost },
            { M::StaticShock, L"Static Shock", L"Spires periodically spawn and target Slayers with shock projectiles.", S::Shock },
            { M::Inferno, L"Inferno", L"Behemoth fire effects last longer and deal more damage.", S::Blaze },
            { M::UmbralInstability, L"Umbral Instability", L"Behemoths have been touched by unstable umbral energy and will periodically create black holes that must be destroyed.", S::Umbral },
            { M::ToughHide, L"Tough Hide", L"Behemoth parts take less damage, but wounded parts take much more damage.", S::Behemoth },
            { M::ShockSmollusks, L"Shock Smollusks", L"Shock smollusks inhabit the area and leave trails of dangerous shock slime wherever they travel. Standing in shock slime will shock the Slayer.", S::Shock },
            { M::SovereignsChosen, L"Sovereign's Chosen", L"This Behemoth has been corrupted by the power of Koshai.", S::Terra },
            { M::Jagged, L"Jagged", L"Attacks that would cause a wound now cause a crippling wound.", S::Behemoth },
            { M::StyxianSacrifice, L"Styxian Sacrifice", L"Styxian predator fauna will hunt lone and injured Slayers but keep their distance from the Behemoth.", S::Umbral },
            { M::RadiantSmollusks, L"Radiant Smollusks", L"Radiant smollusks inhabit the area and leave trails of dangerous radiant slime wherever they travel. Standing in radiant slime will blind the Slayer.", S::Radiant },
            { M::FlamingTail, L"Flaming Tail", L"Behemoth tail attacks deal bonus fire damage and set Slayers on fire.", S::Blaze },
            { M::Momentum, L"Momentum", L"Unstable attacks increase Behemoth damage if they are not interrupted. Interrupting unstable attacks reduces the increased damage.", S::Behemoth },
            { M::Fury, L"Fury", L"Behemoth rage lasts longer and empowers the Behemoth's defense and attack.", S::Behemoth },
            { M::BehemothBlitz, L"Behemoth Blitz", L"Behemoth attack speed is increased.", S::Behemoth },
            { M::VolcanicVitriol, L"Volcanic Vitriol", L"Volcanoes erupt from the ground, spewing lava pools around the battlefield.", S::Blaze },
            { M::CursedLightning, L"Cursed Lightning", L"Slayers are periodically targeted by a lightning curse. All Slayers get the curse; one Slayer gets the bolt.", S::Shock },
            { M::DeepFreeze, L"Deep Freeze", L"Frost damage is increased. Player stamina costs are increased.", S::Frost },
            { M::HotSpot, L"Hot Spot", L"Shock slam attacks leave a temporary shock zone.", S::Blaze },
            { M::WeakSpot, L"Weak Spot", L"Behemoths are more durable but have an unstable weak point.", S::Behemoth },
            { M::LightningStars, L"Lightning Stars", L"Crystals periodically spawn near Slayers and then detonate. If destroyed by Slayers, they spawn a buff.", S::Shock },
            { M::BleedoutVines, L"Bleedout Vines", L"When you enter bleedout, vines surround you.", S::Terra },
            { M::UmbralStars, L"Umbral Stars", L"Crystals periodically spawn near Slayers and detonate after a short duration, causing corruption. If destroyed by Slayers, they spawn a buff.", S::Umbral },
            { M::SplittingUmbral, L"Splitting Umbral", L"An umbral projectile periodically spawns and repeatedly divides in two. Destroying an umbral projectile grants a buff.", S::Umbral },
            { M::UmbralSmollusks, L"Umbral Smollusks", L"Umbral smollusks inhabit the area and leave trails of dangerous umbral slime wherever they travel. Standing in umbral slime will corrupt the Slayer.", S::Umbral },
            { M::IcyGrave, L"Icy Grave", L"When Slayers are frozen, a deadly trap starts to spring.", S::Frost },
            { M::ViciousVigor, L"Vicious Vigor", L"The Behemoth regains 1000 health when damaging a Slayer with physical attacks.", S::Behemoth },
            { M::ThickSkull, L"Thick Skull", L"Behemoths are more difficult to stagger.", S::Behemoth },
            { M::IncandescentIncarceration, L"Incandescent Incarceration", L"Slayers who go down will be trapped by a radiant orb.", S::Radiant },
            { M::BlazeSmollusks, L"Blaze Smollusks", L"Blaze smollusks inhabit the area and leave trails of dangerous blaze slime wherever they travel. Standing in blaze slime will burn the Slayer.", S::Blaze },
            { M::Shockfall, L"Shockfall", L"Behemoth rock attacks shellshock and deal bonus damage to Slayers.", S::Shock },
            { M::LeafShield, L"Leaf Shield", L"On enrage, Behemoths gain a shield that blocks projectile damage and prevents stamina regeneration. It can be destroyed by projectile damage or by causing a stagger.", S::Terra },
            { M::DangerZones, L"Danger Zones", L"Danger Zones periodically appear on the island. Avoid them before they explode!", S::Arena },
            { M::Bombers, L"Bombers", L"Bombers spawn periodically. Killing them grants a bonus the next time you damage a Behemoth. The bonus stacks multiple times.", S::Blaze },
            { M::TrackingLightning, L"Tracking Lightning", L"Slayers are periodically targeted by a lightning curse that predicts their movements.", S::Shock },
        };
    }

    TrialRowList TrialRowsForDifficulty(int DifficultyIndex) {
        if (DifficultyIndex == 1)
            return { DauntlessTrials, static_cast<int>(std::size(DauntlessTrials)) };
        return { NormalTrials, static_cast<int>(std::size(NormalTrials)) };
    }

    std::wstring TrialComboLabel(const TrialRow& Row) {
        wchar_t Label[256] = {};
        swprintf_s(Label, L"%S - %s", Row.Suffix, Row.Behemoth);
        return Label;
    }

    TrialDetails BuildTrialDetails(const TrialRow& Row) {
        TrialDetails Details;
        Details.Behemoth = Row.Behemoth;
        Details.Element = Row.Element;
        Details.Ids = Row.Ids;

        wchar_t ThreatPower[64] = {};
        swprintf_s(ThreatPower, L"Lvl %d / Power %d", Row.Level, Row.Power);
        Details.ThreatPower = ThreatPower;

        if (Row.Atmosphere != nullptr)
            Details.Atmosphere = Row.Atmosphere;

        Details.Modifiers.reserve(std::size(Modifiers));
        for (const ModifierDef& Def : Modifiers) {
            if ((Row.Modifiers & Bit(Def.Id)) != 0)
                Details.Modifiers.push_back({ Def.Name, Def.Description, ModifierStyleFor(Def.Style) });
        }

        return Details;
    }

    ModifierStyle ModifierStyleFor(ModifierStyleId Style) {
        const size_t Index = static_cast<size_t>(Style);
        if (Index < std::size(ModifierStyles))
            return ModifierStyles[Index];
        return ModifierStyles[0];
    }

    COLORREF BehemothColor(BehemothElement Element, bool Selected) {
        const size_t ElementIndex = static_cast<size_t>(Element);
        if (ElementIndex < std::size(BehemothColors))
            return BehemothColors[ElementIndex][Selected ? 1 : 0];
        return BehemothColors[0][Selected ? 1 : 0];
    }
}
