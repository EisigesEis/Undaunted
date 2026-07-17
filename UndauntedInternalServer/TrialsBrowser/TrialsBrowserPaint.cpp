#include "TrialsBrowserPaint.h"

#include <algorithm>
#include <iterator>
#include <uxtheme.h>
#include <dwmapi.h>

namespace TrialsBrowserOverlay {
    namespace {
        void FrameRectColor(HDC Dc, const RECT& Rect, COLORREF Color) {
            HBRUSH Brush = CreateSolidBrush(Color);
            FrameRect(Dc, &Rect, Brush);
            DeleteObject(Brush);
        }

        void DrawCenteredText(HDC Dc, const RECT& Rect, const wchar_t* Text, HFONT Font, COLORREF TextColor) {
            HFONT OldFont = Font != nullptr ? static_cast<HFONT>(SelectObject(Dc, Font)) : nullptr;
            SetBkMode(Dc, TRANSPARENT);
            SetTextColor(Dc, TextColor);
            RECT TextRect = Rect;
            DrawTextW(Dc, Text, -1, &TextRect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            if (OldFont != nullptr)
                SelectObject(Dc, OldFont);
        }

        COLORREF ComboTextColor(int ItemId, bool BehemothCombo, bool Selected, int DifficultyIndex) {
            if (!BehemothCombo || ItemId < 0)
                return Selected ? RGB(245, 248, 252) : kText;

            const TrialRowList Rows = TrialRowsForDifficulty(DifficultyIndex);
            if (ItemId >= Rows.Count)
                return kText;

            return BehemothColor(Rows.Rows[ItemId].Element, Selected);
        }

        void DrawChip(HDC Dc, const RECT& Rect, const ModifierChip& Chip) {
            HBRUSH Brush = CreateSolidBrush(Chip.Style.Fill);
            HPEN Pen = CreatePen(PS_SOLID, 1, Chip.Style.Border);
            HBRUSH OldBrush = static_cast<HBRUSH>(SelectObject(Dc, Brush));
            HPEN OldPen = static_cast<HPEN>(SelectObject(Dc, Pen));
            RoundRect(Dc, Rect.left, Rect.top, Rect.right, Rect.bottom, 8, 8);
            SelectObject(Dc, OldPen);
            SelectObject(Dc, OldBrush);
            DeleteObject(Pen);
            DeleteObject(Brush);

            RECT Stripe = { Rect.left + 4, Rect.top + 4, Rect.left + 7, Rect.bottom - 4 };
            FillRectColor(Dc, Stripe, Chip.Style.Accent);

            HBRUSH DotBrush = CreateSolidBrush(Chip.Style.Accent);
            HBRUSH PreviousBrush = static_cast<HBRUSH>(SelectObject(Dc, DotBrush));
            HPEN DotPen = CreatePen(PS_SOLID, 1, Chip.Style.Accent);
            HPEN PreviousPen = static_cast<HPEN>(SelectObject(Dc, DotPen));
            Ellipse(Dc, Rect.right - 12, Rect.top + 7, Rect.right - 6, Rect.top + 13);
            SelectObject(Dc, PreviousPen);
            SelectObject(Dc, PreviousBrush);
            DeleteObject(DotPen);
            DeleteObject(DotBrush);

            RECT TextRect = Rect;
            TextRect.left += 12;
            TextRect.right -= 14;

            SetTextColor(Dc, Chip.Style.Text);
            DrawTextW(Dc, Chip.Text, -1, &TextRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        }

        int MeasureChipWidth(HDC Dc, const ModifierChip& Chip) {
            RECT TextRect = {};
            DrawTextW(Dc, Chip.Text, -1, &TextRect, DT_SINGLELINE | DT_NOPREFIX | DT_CALCRECT);
            return (std::max)(46L, TextRect.right - TextRect.left + 30L);
        }
    }

    void ApplyDarkTheme(HWND Control) {
        if (Control != nullptr)
            SetWindowTheme(Control, L"DarkMode_Explorer", nullptr);
    }

    void EnableDarkTitleBar(HWND Hwnd) {
        const BOOL Enabled = TRUE;
        DwmSetWindowAttribute(Hwnd, 20, &Enabled, sizeof(Enabled));
        DwmSetWindowAttribute(Hwnd, 19, &Enabled, sizeof(Enabled));
        DwmSetWindowAttribute(Hwnd, 35, &kTitle, sizeof(kTitle));
        DwmSetWindowAttribute(Hwnd, 36, &kText, sizeof(kText));
    }

    void FillRectColor(HDC Dc, const RECT& Rect, COLORREF Color) {
        HBRUSH Brush = CreateSolidBrush(Color);
        FillRect(Dc, &Rect, Brush);
        DeleteObject(Brush);
    }

    void DrawDarkButton(const DRAWITEMSTRUCT* Item, HFONT Font) {
        if (Item == nullptr)
            return;

        wchar_t Text[160] = {};
        GetWindowTextW(Item->hwndItem, Text, static_cast<int>(std::size(Text)));

        const bool Pressed = (Item->itemState & ODS_SELECTED) != 0;
        const bool Focused = (Item->itemState & ODS_FOCUS) != 0;
        const bool Disabled = (Item->itemState & ODS_DISABLED) != 0;
        const COLORREF Fill = Disabled ? kPanel : (Pressed ? kPanelPressed : kPanelHover);
        const COLORREF TextColor = Disabled ? RGB(120, 128, 140) : kText;

        FillRectColor(Item->hDC, Item->rcItem, Fill);
        FrameRectColor(Item->hDC, Item->rcItem, Focused ? kBorderFocus : kBorder);
        DrawCenteredText(Item->hDC, Item->rcItem, Text, Font, TextColor);
    }

    void DrawDarkCheckbox(const DRAWITEMSTRUCT* Item, bool Checked) {
        if (Item == nullptr)
            return;

        const bool Pressed = (Item->itemState & ODS_SELECTED) != 0;
        const bool Focused = (Item->itemState & ODS_FOCUS) != 0;

        FillRectColor(Item->hDC, Item->rcItem, kBg);

        RECT Box = Item->rcItem;
        Box.left += 1;
        Box.top += 1;
        Box.right = Box.left + 15;
        Box.bottom = Box.top + 15;

        FillRectColor(Item->hDC, Box, Pressed ? kPanelPressed : kPanel);
        FrameRectColor(Item->hDC, Box, Focused ? kBorderFocus : kBorder);

        if (!Checked)
            return;

        HPEN Pen = CreatePen(PS_SOLID, 2, kText);
        HPEN OldPen = static_cast<HPEN>(SelectObject(Item->hDC, Pen));
        MoveToEx(Item->hDC, Box.left + 3, Box.top + 8, nullptr);
        LineTo(Item->hDC, Box.left + 7, Box.top + 12);
        LineTo(Item->hDC, Box.right - 3, Box.top + 4);
        SelectObject(Item->hDC, OldPen);
        DeleteObject(Pen);
    }

    void DrawTrialDetails(const DRAWITEMSTRUCT* Item, const TrialDetails& Details, HFONT Font, std::vector<ModifierChipHitRegion>* HitRegions) {
        if (Item == nullptr)
            return;

        if (HitRegions != nullptr)
            HitRegions->clear();

        FillRectColor(Item->hDC, Item->rcItem, kBg);

        RECT Rect = Item->rcItem;
        Rect.left += 1;
        Rect.right -= 1;

        HFONT OldFont = Font != nullptr ? static_cast<HFONT>(SelectObject(Item->hDC, Font)) : nullptr;
        SetBkMode(Item->hDC, TRANSPARENT);

        RECT TitleRect = Rect;
        TitleRect.bottom = TitleRect.top + 18;
        SetTextColor(Item->hDC, BehemothColor(Details.Element));
        DrawTextW(Item->hDC, Details.Behemoth.c_str(), -1, &TitleRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);

        std::wstring Meta;
        if (!Details.Ids.empty())
            Meta += L"IDs " + Details.Ids;
        if (!Details.ThreatPower.empty())
            Meta += (Meta.empty() ? L"" : L" | ") + Details.ThreatPower;
        if (!Details.Atmosphere.empty())
            Meta += (Meta.empty() ? L"" : L" | ") + Details.Atmosphere;

        RECT MetaRect = Rect;
        MetaRect.top += 18;
        MetaRect.bottom = MetaRect.top + 16;
        SetTextColor(Item->hDC, RGB(169, 178, 190));
        DrawTextW(Item->hDC, Meta.c_str(), -1, &MetaRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);

        int X = Rect.left;
        int Y = Rect.top + 38;
        constexpr int ChipHeight = 20;
        constexpr int ChipGap = 5;

        for (const ModifierChip& Chip : Details.Modifiers) {
            const int MaxChipWidth = static_cast<int>(Rect.right - Rect.left);
            const int Width = (std::min)(MeasureChipWidth(Item->hDC, Chip), MaxChipWidth);

            if (X != Rect.left && X + Width > Rect.right) {
                X = Rect.left;
                Y += ChipHeight + ChipGap;
            }

            if (Y + ChipHeight > Rect.bottom)
                break;

            const RECT ChipRect = { X, Y, X + Width, Y + ChipHeight };
            DrawChip(Item->hDC, ChipRect, Chip);
            if (HitRegions != nullptr && Chip.Description != nullptr && Chip.Description[0] != L'\0')
                HitRegions->push_back({ ChipRect, Chip.Description, Chip.Style });
            X += Width + ChipGap;
        }

        if (OldFont != nullptr)
            SelectObject(Item->hDC, OldFont);
    }

    void DrawComboItem(const DRAWITEMSTRUCT* Item, HFONT Font, bool BehemothCombo, int DifficultyIndex) {
        if (Item == nullptr)
            return;

        wchar_t Text[1024] = {};
        if (Item->itemID != static_cast<UINT>(-1))
            SendMessageW(Item->hwndItem, CB_GETLBTEXT, Item->itemID, reinterpret_cast<LPARAM>(Text));
        else
            GetWindowTextW(Item->hwndItem, Text, static_cast<int>(std::size(Text)));

        const bool Selected = (Item->itemState & ODS_SELECTED) != 0;
        const bool Focused = (Item->itemState & ODS_FOCUS) != 0;
        FillRectColor(Item->hDC, Item->rcItem, Selected ? kSelection : kPanel);

        RECT TextRect = Item->rcItem;
        TextRect.left += 7;
        TextRect.right -= 7;

        HFONT OldFont = Font != nullptr ? static_cast<HFONT>(SelectObject(Item->hDC, Font)) : nullptr;
        SetBkMode(Item->hDC, TRANSPARENT);
        SetTextColor(Item->hDC, ComboTextColor(static_cast<int>(Item->itemID), BehemothCombo, Selected, DifficultyIndex));
        DrawTextW(Item->hDC, Text, -1, &TextRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        if (OldFont != nullptr)
            SelectObject(Item->hDC, OldFont);

        if (Focused)
            FrameRectColor(Item->hDC, Item->rcItem, kBorderFocus);
    }

    void DrawComboFace(HWND Hwnd, HDC Dc, HFONT Font, bool BehemothCombo, int DifficultyIndex) {
        RECT Rect = {};
        GetClientRect(Hwnd, &Rect);
        FillRectColor(Dc, Rect, kPanel);

        RECT ArrowRect = Rect;
        ArrowRect.left = ArrowRect.right - 24;
        if (ArrowRect.left < Rect.left)
            ArrowRect.left = Rect.left;
        FillRectColor(Dc, ArrowRect, kPanelHover);

        wchar_t Text[1024] = {};
        const int SelectedIndex = static_cast<int>(SendMessageW(Hwnd, CB_GETCURSEL, 0, 0));
        if (SelectedIndex != CB_ERR)
            SendMessageW(Hwnd, CB_GETLBTEXT, SelectedIndex, reinterpret_cast<LPARAM>(Text));

        RECT TextRect = Rect;
        TextRect.left += 7;
        TextRect.right = ArrowRect.left - 5;
        if (TextRect.right < TextRect.left)
            TextRect.right = TextRect.left;

        HFONT OldFont = Font != nullptr ? static_cast<HFONT>(SelectObject(Dc, Font)) : nullptr;
        SetBkMode(Dc, TRANSPARENT);
        SetTextColor(Dc, IsWindowEnabled(Hwnd) ? ComboTextColor(SelectedIndex, BehemothCombo, false, DifficultyIndex) : RGB(120, 128, 140));
        DrawTextW(Dc, Text, -1, &TextRect, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        if (OldFont != nullptr)
            SelectObject(Dc, OldFont);

        const int CenterX = (ArrowRect.left + ArrowRect.right) / 2;
        const int CenterY = (ArrowRect.top + ArrowRect.bottom) / 2;
        POINT ArrowPoints[] = { { CenterX - 4, CenterY - 2 }, { CenterX + 4, CenterY - 2 }, { CenterX, CenterY + 3 } };

        HBRUSH ArrowBrush = CreateSolidBrush(kText);
        HPEN ArrowPen = CreatePen(PS_SOLID, 1, kText);
        HBRUSH OldBrush = static_cast<HBRUSH>(SelectObject(Dc, ArrowBrush));
        HPEN OldPen = static_cast<HPEN>(SelectObject(Dc, ArrowPen));
        Polygon(Dc, ArrowPoints, 3);
        SelectObject(Dc, OldPen);
        SelectObject(Dc, OldBrush);
        DeleteObject(ArrowPen);
        DeleteObject(ArrowBrush);

        FrameRectColor(Dc, Rect, GetFocus() == Hwnd ? kBorderFocus : kBorder);
    }
}
