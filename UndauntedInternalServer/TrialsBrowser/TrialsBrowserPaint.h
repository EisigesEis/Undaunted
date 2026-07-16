#pragma once

#include "TrialsBrowserData.h"

#include <vector>
#include <windows.h>

namespace TrialsBrowserOverlay {
    constexpr COLORREF kBg = RGB(19, 22, 28);
    constexpr COLORREF kPanel = RGB(30, 35, 44);
    constexpr COLORREF kPanelHover = RGB(40, 47, 58);
    constexpr COLORREF kPanelPressed = RGB(24, 29, 37);
    constexpr COLORREF kSelection = RGB(57, 82, 99);
    constexpr COLORREF kBorder = RGB(82, 92, 108);
    constexpr COLORREF kBorderFocus = RGB(109, 145, 166);
    constexpr COLORREF kText = RGB(213, 219, 229);
    constexpr COLORREF kTitle = RGB(28, 32, 39);

    struct ModifierChipHitRegion {
        RECT Rect = {};
        const wchar_t* Description = L"";
    };

    void ApplyDarkTheme(HWND Control);
    void EnableDarkTitleBar(HWND Hwnd);
    void FillRectColor(HDC Dc, const RECT& Rect, COLORREF Color);

    void DrawDarkButton(const DRAWITEMSTRUCT* Item, HFONT Font);
    void DrawDarkCheckbox(const DRAWITEMSTRUCT* Item, bool Checked);
    void DrawTrialDetails(const DRAWITEMSTRUCT* Item, const TrialDetails& Details, HFONT Font, std::vector<ModifierChipHitRegion>* HitRegions);
    void DrawComboItem(const DRAWITEMSTRUCT* Item, HFONT Font, bool BehemothCombo, int DifficultyIndex);
    void DrawComboFace(HWND Hwnd, HDC Dc, HFONT Font, bool BehemothCombo, int DifficultyIndex);
}
