#include "TrialsBrowserOverlay.h"
#include "TrialsBrowserData.h"
#include "TrialsBrowserPaint.h"
#include "TrialsBrowserQueue.h"

#include <commctrl.h>
#include <dwmapi.h>
#include <uxtheme.h>
#include <atomic>
#include <mutex>
#include <optional>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>
#include <windows.h>
#include <windowsx.h>

#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "uxtheme.lib")

using namespace SDK;

namespace Globals {
    extern bool AmServer;
}

namespace TrialsBrowserOverlay {

    namespace {
        enum ControlId {
            kDifficultyCombo = 1001,
            kBehemothCombo = 1002,
            kPrivateCheckbox = 1003,
            kAtmosphereCombo = 1008,
            kQueueButton = 1004,
            kRamsgateButton = 1005,
            kStatusLabel = 1006,
            kDetailsPanel = 1007,
        };

        constexpr UINT kToggleWindowMessage = WM_APP + 1;
        constexpr UINT kApplyQueueUpdateMessage = WM_APP + 2;

        HWND Window = nullptr;
        HWND StatusLabel = nullptr;
        HWND DetailsPanel = nullptr;
        HFONT UiFont = nullptr;
        HFONT ButtonFont = nullptr;
        HBRUSH DarkBrush = nullptr;
        HBRUSH ControlBrush = nullptr;
        HICON TitleIconSmall = nullptr;
        HICON TitleIconBig = nullptr;
        WNDPROC OriginalComboProc = nullptr;
        WNDPROC OriginalDetailsProc = nullptr;
        HWND ModifierTooltip = nullptr;
        bool PrivateHuntChecked = true;
        bool TrackingDetailsMouse = false;
        int HoveredModifier = -1;
        std::wstring ModifierTooltipText;
        TrialDetails CurrentDetails;
        std::vector<ModifierChipHitRegion> ModifierHitRegions;
        std::atomic_bool Started = false;
        std::atomic_bool StartRequested = false;
        std::mutex QueueUiUpdateMutex;
        std::optional<QueueUiUpdate> PendingQueueUiUpdate;
        DWORD UiThreadId = 0;

        void HideModifierTooltip() {
            if (ModifierTooltip != nullptr && DetailsPanel != nullptr) {
                TOOLINFOW Tool = {};
                Tool.cbSize = sizeof(Tool);
                Tool.hwnd = DetailsPanel;
                Tool.uId = 1;
                SendMessageW(ModifierTooltip, TTM_TRACKACTIVATE, FALSE, reinterpret_cast<LPARAM>(&Tool));
            }
            HoveredModifier = -1;
        }

        void ApplyModifierTooltipStyle(const ModifierStyle* Style) {
            if (ModifierTooltip == nullptr)
                return;

            const COLORREF Fill = Style != nullptr ? Style->Fill : kPanelHover;
            const COLORREF Text = Style != nullptr ? Style->Text : kText;
            SendMessageW(ModifierTooltip, TTM_SETTIPBKCOLOR, Fill, 0);
            SendMessageW(ModifierTooltip, TTM_SETTIPTEXTCOLOR, Text, 0);
            SendMessageW(ModifierTooltip, TTM_UPDATE, 0, 0);
            RedrawWindow(ModifierTooltip, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_FRAME);
        }

        void UpdateModifierTooltip(POINT Point) {
            int HitIndex = -1;
            for (size_t Index = 0; Index < ModifierHitRegions.size(); ++Index) {
                if (PtInRect(&ModifierHitRegions[Index].Rect, Point)) {
                    HitIndex = static_cast<int>(Index);
                    break;
                }
            }

            if (HitIndex == HoveredModifier)
                return;

            HideModifierTooltip();
            if (HitIndex < 0 || ModifierTooltip == nullptr || DetailsPanel == nullptr)
                return;

            TOOLINFOW Tool = {};
            Tool.cbSize = sizeof(Tool);
            Tool.hwnd = DetailsPanel;
            Tool.uId = 1;
            ModifierTooltipText = ModifierHitRegions[HitIndex].Description;
            Tool.lpszText = ModifierTooltipText.data();
            ApplyModifierTooltipStyle(&ModifierHitRegions[HitIndex].Style);
            SendMessageW(ModifierTooltip, TTM_UPDATETIPTEXTW, 0, reinterpret_cast<LPARAM>(&Tool));

            POINT ScreenPoint = Point;
            ClientToScreen(DetailsPanel, &ScreenPoint);
            SendMessageW(ModifierTooltip, TTM_TRACKPOSITION, 0, MAKELPARAM(ScreenPoint.x + 14, ScreenPoint.y + 20));
            SendMessageW(ModifierTooltip, TTM_TRACKACTIVATE, TRUE, reinterpret_cast<LPARAM>(&Tool));
            HoveredModifier = HitIndex;
        }

        LRESULT CALLBACK DetailsPanelProc(HWND Hwnd, UINT Message, WPARAM WParam, LPARAM LParam) {
            switch (Message) {
            case WM_MOUSEMOVE: {
                if (!TrackingDetailsMouse) {
                    TRACKMOUSEEVENT Tracking = { sizeof(Tracking), TME_LEAVE, Hwnd, 0 };
                    TrackMouseEvent(&Tracking);
                    TrackingDetailsMouse = true;
                }
                UpdateModifierTooltip({ GET_X_LPARAM(LParam), GET_Y_LPARAM(LParam) });
                break;
            }
            case WM_MOUSELEAVE:
                TrackingDetailsMouse = false;
                HideModifierTooltip();
                break;
            case WM_NCDESTROY:
                TrackingDetailsMouse = false;
                HideModifierTooltip();
                break;
            }

            return OriginalDetailsProc != nullptr
                ? CallWindowProcW(OriginalDetailsProc, Hwnd, Message, WParam, LParam)
                : DefWindowProcW(Hwnd, Message, WParam, LParam);
        }

        void ApplyFont(HWND Control, HFONT Font) {
            if (Control != nullptr && Font != nullptr)
                SendMessageW(Control, WM_SETFONT, reinterpret_cast<WPARAM>(Font), TRUE);
        }

        int ComboIndex(HWND Parent, int Id) {
            HWND Combo = GetDlgItem(Parent, Id);
            return Combo != nullptr ? static_cast<int>(SendMessageW(Combo, CB_GETCURSEL, 0, 0)) : CB_ERR;
        }

        int DifficultyIndex(HWND Parent) {
            const int Index = ComboIndex(Parent, kDifficultyCombo);
            return Index == CB_ERR ? 0 : Index;
        }

        int AtmosphereIndex(HWND Parent) {
            const int Index = ComboIndex(Parent, kAtmosphereCombo);
            return Index == CB_ERR ? 0 : Index;
        }

        void SetStatus(const std::wstring& Status) {
            if (StatusLabel != nullptr)
                SetWindowTextW(StatusLabel, Status.c_str());
        }

        void EnableQueueButtons(bool Enabled) {
            if (Window == nullptr)
                return;

            for (int Id : { kQueueButton, kRamsgateButton }) {
                HWND Button = GetDlgItem(Window, Id);
                if (Button != nullptr) {
                    EnableWindow(Button, Enabled);
                    InvalidateRect(Button, nullptr, TRUE);
                }
            }
        }

        void ApplyQueueUiUpdate(const QueueUiUpdate& Update) {
            EnableQueueButtons(Update.ButtonsEnabled);
            SetStatus(Update.Status);
        }

        void EnableQueueUiUpdates() {
            std::lock_guard<std::mutex> Lock(QueueUiUpdateMutex);
            PendingQueueUiUpdate.reset();
            UiThreadId = GetCurrentThreadId();
        }

        void DisableQueueUiUpdates() {
            std::lock_guard<std::mutex> Lock(QueueUiUpdateMutex);
            UiThreadId = 0;
            PendingQueueUiUpdate.reset();
        }

        void PublishQueueUiUpdate(QueueUiUpdate Update) {
            std::lock_guard<std::mutex> Lock(QueueUiUpdateMutex);
            if (UiThreadId == 0)
                return;

            PendingQueueUiUpdate = std::move(Update);
            PostThreadMessageW(UiThreadId, kApplyQueueUpdateMessage, 0, 0);
        }

        void PostUiThreadMessage(UINT Message) {
            std::lock_guard<std::mutex> Lock(QueueUiUpdateMutex);
            if (UiThreadId != 0)
                PostThreadMessageW(UiThreadId, Message, 0, 0);
        }

        std::optional<QueueUiUpdate> TakeQueueUiUpdate() {
            std::lock_guard<std::mutex> Lock(QueueUiUpdateMutex);
            if (UiThreadId == 0)
                return std::nullopt;

            return std::exchange(PendingQueueUiUpdate, std::nullopt);
        }

        void ToggleWindow() {
            if (Window == nullptr)
                return;

            const bool IsVisible = IsWindowVisible(Window);
            if (IsVisible)
                HideModifierTooltip();
            ShowWindow(Window, IsVisible ? SW_HIDE : SW_SHOWNORMAL);
            if (!IsVisible)
                SetForegroundWindow(Window);
        }

        HWND CreateLabel(HWND Parent, const wchar_t* Text, int X, int Y, int Width, int Height) {
            HWND Control = CreateWindowW(L"STATIC", Text, WS_CHILD | WS_VISIBLE | SS_LEFT | SS_NOPREFIX, X, Y, Width, Height, Parent, nullptr, nullptr, nullptr);
            ApplyFont(Control, UiFont);
            return Control;
        }

        HICON CreateTransparentIcon(int Size) {
            const int BytesPerMask = ((Size + 15) / 16) * 2 * Size;
            std::vector<BYTE> AndMask(static_cast<size_t>(BytesPerMask), 0xFF);
            std::vector<BYTE> XorMask(static_cast<size_t>(BytesPerMask), 0x00);
            return CreateIcon(GetModuleHandleW(nullptr), Size, Size, 1, 1, AndMask.data(), XorMask.data());
        }

        HWND CreateButtonControl(HWND Parent, const wchar_t* Text, int X, int Y, int Width, int Height, int Id) {
            HWND Control = CreateWindowW(L"BUTTON", Text, WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, X, Y, Width, Height, Parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(Id)), nullptr, nullptr);
            ApplyFont(Control, ButtonFont);
            ApplyDarkTheme(Control);
            return Control;
        }

        HWND CreateCheckboxControl(HWND Parent, int X, int Y, int Id) {
            HWND Control = CreateWindowW(L"BUTTON", L"", WS_CHILD | WS_VISIBLE | BS_OWNERDRAW, X, Y, 20, 20, Parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(Id)), nullptr, nullptr);
            ApplyFont(Control, UiFont);
            ApplyDarkTheme(Control);
            return Control;
        }

        HWND CreateCombo(HWND Parent, int Id, int X, int Y, int Width, int Height) {
            HWND Control = CreateWindowW(L"COMBOBOX", nullptr, WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST | CBS_OWNERDRAWFIXED | CBS_HASSTRINGS | WS_VSCROLL, X, Y, Width, Height, Parent, reinterpret_cast<HMENU>(static_cast<INT_PTR>(Id)), nullptr, nullptr);
            ApplyFont(Control, UiFont);
            ApplyDarkTheme(Control);

            const LONG_PTR PreviousProc = SetWindowLongPtrW(Control, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(+[](HWND Hwnd, UINT Message, WPARAM WParam, LPARAM LParam) -> LRESULT {
                const auto CallOriginal = [&]() {
                    return OriginalComboProc != nullptr
                        ? CallWindowProcW(OriginalComboProc, Hwnd, Message, WParam, LParam)
                        : DefWindowProcW(Hwnd, Message, WParam, LParam);
                };

                switch (Message) {
                case WM_PAINT: {
                    PAINTSTRUCT Paint = {};
                    HDC Dc = BeginPaint(Hwnd, &Paint);
                    DrawComboFace(Hwnd, Dc, UiFont, GetDlgCtrlID(Hwnd) == kBehemothCombo, DifficultyIndex(GetParent(Hwnd)));
                    EndPaint(Hwnd, &Paint);
                    return 0;
                }
                case WM_PRINTCLIENT:
                    DrawComboFace(Hwnd, reinterpret_cast<HDC>(WParam), UiFont, GetDlgCtrlID(Hwnd) == kBehemothCombo, DifficultyIndex(GetParent(Hwnd)));
                    return 0;
                case WM_ERASEBKGND:
                    return TRUE;
                case WM_SETFOCUS:
                case WM_KILLFOCUS:
                case WM_ENABLE:
                case CB_SETCURSEL: {
                    const LRESULT Result = CallOriginal();
                    InvalidateRect(Hwnd, nullptr, TRUE);
                    return Result;
                }
                default:
                    return CallOriginal();
                }
            }));

            if (OriginalComboProc == nullptr)
                OriginalComboProc = reinterpret_cast<WNDPROC>(PreviousProc);
            return Control;
        }

        void AddComboString(HWND Combo, const wchar_t* Text) {
            SendMessageW(Combo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(Text));
        }

        void PopulateTrialOptions(HWND Combo, int Difficulty, const std::wstring& PreferredBehemoth = {}) {
            if (Combo == nullptr)
                return;

            SendMessageW(Combo, WM_SETREDRAW, FALSE, 0);
            SendMessageW(Combo, CB_RESETCONTENT, 0, 0);
            const TrialRowList Rows = TrialRowsForDifficulty(Difficulty);
            int SelectedIndex = -1;
            for (int Index = 0; Index < Rows.Count; ++Index) {
                const std::wstring Label = TrialComboLabel(Rows.Rows[Index]);
                AddComboString(Combo, Label.c_str());
                if (SelectedIndex < 0 && !PreferredBehemoth.empty() && PreferredBehemoth == Rows.Rows[Index].Behemoth)
                    SelectedIndex = Index;
            }

            if (Rows.Count > 0)
                SendMessageW(Combo, CB_SETCURSEL, SelectedIndex >= 0 ? SelectedIndex : 0, 0);
            SendMessageW(Combo, WM_SETREDRAW, TRUE, 0);
            RedrawWindow(Combo, nullptr, nullptr, RDW_INVALIDATE | RDW_UPDATENOW | RDW_NOERASE);
        }

        const TrialRow* SelectedTrialRow(HWND Hwnd) {
            const TrialRowList Rows = TrialRowsForDifficulty(DifficultyIndex(Hwnd));
            const int BehemothIndex = ComboIndex(Hwnd, kBehemothCombo);
            return BehemothIndex >= 0 && BehemothIndex < Rows.Count ? &Rows.Rows[BehemothIndex] : nullptr;
        }

        void UpdateTrialDetails(HWND Hwnd) {
            if (DetailsPanel == nullptr)
                return;

            HideModifierTooltip();
            ApplyModifierTooltipStyle(nullptr);
            ModifierHitRegions.clear();

            if (const TrialRow* Row = SelectedTrialRow(Hwnd))
                CurrentDetails = BuildTrialDetails(*Row);
            else
                CurrentDetails = {};

            if (HWND Atmosphere = GetDlgItem(Hwnd, kAtmosphereCombo); Atmosphere != nullptr) {
                const int Selected = AtmosphereIndex(Hwnd);
                std::wstring DefaultLabel = L"Default";
                if (!CurrentDetails.Atmosphere.empty()) {
                    DefaultLabel.append(L" (");
                    DefaultLabel.append(CurrentDetails.Atmosphere);
                    DefaultLabel.push_back(L')');
                }
                SendMessageW(Atmosphere, CB_DELETESTRING, 0, 0);
                SendMessageW(Atmosphere, CB_INSERTSTRING, 0, reinterpret_cast<LPARAM>(DefaultLabel.c_str()));
                SendMessageW(Atmosphere, CB_SETCURSEL, Selected >= 0 ? Selected : 0, 0);
            }

            InvalidateRect(DetailsPanel, nullptr, TRUE);
        }

        std::wstring SelectedPlayerHuntId(HWND Hwnd) {
            const TrialRow* Row = SelectedTrialRow(Hwnd);
            if (Row == nullptr)
                return L"";

            const wchar_t* Prefix = DifficultyIndex(Hwnd) == 1 ? L"Trials_PlayerHunt_Elite_" : L"Trials_PlayerHunt_Hard_";
            static constexpr const wchar_t* AtmosphereSuffixes[] = { L"", L"_Day", L"_Night" };
            const int Atmosphere = AtmosphereIndex(Hwnd);
            const wchar_t* Suffix = Atmosphere >= 0 && Atmosphere < 3
                ? AtmosphereSuffixes[Atmosphere]
                : L"";
            return std::wstring(Prefix) + Row->Suffix + Suffix;
        }

        void CreateControls(HWND Hwnd) {
            UiFont = CreateFontW(15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
            ButtonFont = CreateFontW(15, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Segoe UI");
            DarkBrush = CreateSolidBrush(kBg);
            ControlBrush = CreateSolidBrush(kPanel);

            HWND Behemoth = CreateCombo(Hwnd, kBehemothCombo, 16, 16, 360, 400);
            PopulateTrialOptions(Behemoth, 1);

            DetailsPanel = CreateWindowW(L"STATIC", nullptr, WS_CHILD | WS_VISIBLE | SS_OWNERDRAW | SS_NOTIFY, 16, 50, 360, 112, Hwnd, reinterpret_cast<HMENU>(static_cast<INT_PTR>(kDetailsPanel)), nullptr, nullptr);
            ApplyFont(DetailsPanel, UiFont);
            OriginalDetailsProc = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(DetailsPanel, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(DetailsPanelProc)));

            ModifierTooltip = CreateWindowExW(
                WS_EX_TOPMOST,
                TOOLTIPS_CLASSW,
                nullptr,
                WS_POPUP | TTS_ALWAYSTIP | TTS_NOPREFIX | TTS_NOANIMATE | TTS_NOFADE,
                CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT, CW_USEDEFAULT,
                Hwnd, nullptr, GetModuleHandleW(nullptr), nullptr
            );
            if (ModifierTooltip != nullptr) {
                SetWindowTheme(ModifierTooltip, L"", L"");
                SendMessageW(ModifierTooltip, WM_SETFONT, reinterpret_cast<WPARAM>(UiFont), FALSE);
                SendMessageW(ModifierTooltip, TTM_SETMAXTIPWIDTH, 0, 320);
                ApplyModifierTooltipStyle(nullptr);
                RECT TooltipMargin = { 6, 4, 6, 4 };
                SendMessageW(ModifierTooltip, TTM_SETMARGIN, 0, reinterpret_cast<LPARAM>(&TooltipMargin));

                TOOLINFOW Tool = {};
                Tool.cbSize = sizeof(Tool);
                Tool.uFlags = TTF_TRACK | TTF_ABSOLUTE;
                Tool.hwnd = DetailsPanel;
                Tool.uId = 1;
                GetClientRect(DetailsPanel, &Tool.rect);
                Tool.lpszText = const_cast<wchar_t*>(L"");
                SendMessageW(ModifierTooltip, TTM_ADDTOOLW, 0, reinterpret_cast<LPARAM>(&Tool));
            }
            CreateLabel(Hwnd, L"Difficulty", 16, 164, 112, 16);
            HWND Difficulty = CreateCombo(Hwnd, kDifficultyCombo, 16, 180, 120, 160);
            AddComboString(Difficulty, L"Normal");
            AddComboString(Difficulty, L"Dauntless");
            SendMessageW(Difficulty, CB_SETCURSEL, 1, 0);

            CreateLabel(Hwnd, L"Atmosphere", 146, 164, 112, 16);
            HWND Atmosphere = CreateCombo(Hwnd, kAtmosphereCombo, 146, 180, 120, 160);
            AddComboString(Atmosphere, L"Default");
            AddComboString(Atmosphere, L"Day");
            AddComboString(Atmosphere, L"Night");
            SendMessageW(Atmosphere, CB_SETCURSEL, 0, 0);
            UpdateTrialDetails(Hwnd);

            HWND Private = CreateCheckboxControl(Hwnd, 276, 184, kPrivateCheckbox);
            CreateLabel(Hwnd, L"Private", 302, 184, 72, 22);
            InvalidateRect(Private, nullptr, TRUE);

            CreateButtonControl(Hwnd, L"Queue Trial", 16, 215, 174, 38, kQueueButton);
            CreateButtonControl(Hwnd, L"Return to Ramsgate", 202, 215, 174, 38, kRamsgateButton);
            StatusLabel = CreateLabel(Hwnd, L"Ready.", 16, 272, 360, 44);
        }

        void DestroyResources() {
            HideModifierTooltip();
            if (ModifierTooltip != nullptr && IsWindow(ModifierTooltip))
                DestroyWindow(ModifierTooltip);
            if (UiFont != nullptr) DeleteObject(UiFont);
            if (ButtonFont != nullptr) DeleteObject(ButtonFont);
            if (DarkBrush != nullptr) DeleteObject(DarkBrush);
            if (ControlBrush != nullptr) DeleteObject(ControlBrush);
            if (TitleIconSmall != nullptr) DestroyIcon(TitleIconSmall);
            if (TitleIconBig != nullptr) DestroyIcon(TitleIconBig);
            Window = nullptr;
            StatusLabel = nullptr;
            DetailsPanel = nullptr;
            UiFont = nullptr;
            ButtonFont = nullptr;
            DarkBrush = nullptr;
            ControlBrush = nullptr;
            TitleIconSmall = nullptr;
            TitleIconBig = nullptr;
            ModifierTooltip = nullptr;
            ModifierTooltipText.clear();
            OriginalComboProc = nullptr;
            OriginalDetailsProc = nullptr;
            TrackingDetailsMouse = false;
            HoveredModifier = -1;
            CurrentDetails = TrialDetails{};
            ModifierHitRegions.clear();
            ResetQueue();
        }

        LRESULT CALLBACK WindowProc(HWND Hwnd, UINT Message, WPARAM WParam, LPARAM LParam) {
            switch (Message) {
            case WM_CREATE:
                EnableDarkTitleBar(Hwnd);
                CreateControls(Hwnd);
                return 0;

            case WM_CTLCOLORSTATIC:
                SetTextColor(reinterpret_cast<HDC>(WParam), kText);
                SetBkColor(reinterpret_cast<HDC>(WParam), kBg);
                return reinterpret_cast<LRESULT>(DarkBrush);

            case WM_CTLCOLORBTN:
            case WM_CTLCOLOREDIT:
            case WM_CTLCOLORLISTBOX:
                SetTextColor(reinterpret_cast<HDC>(WParam), kText);
                SetBkColor(reinterpret_cast<HDC>(WParam), kPanel);
                return reinterpret_cast<LRESULT>(ControlBrush);

            case WM_ERASEBKGND: {
                RECT ClientRect = {};
                GetClientRect(Hwnd, &ClientRect);
                FillRectColor(reinterpret_cast<HDC>(WParam), ClientRect, kBg);
                return TRUE;
            }

            case WM_MEASUREITEM: {
                auto* Measure = reinterpret_cast<MEASUREITEMSTRUCT*>(LParam);
                if (Measure != nullptr && (Measure->CtlID == kDifficultyCombo || Measure->CtlID == kBehemothCombo || Measure->CtlID == kAtmosphereCombo)) {
                    Measure->itemHeight = 22;
                    return TRUE;
                }
                return 0;
            }

            case WM_DRAWITEM: {
                auto* DrawItem = reinterpret_cast<DRAWITEMSTRUCT*>(LParam);
                if (DrawItem == nullptr)
                    return 0;

                if (DrawItem->CtlID == kQueueButton || DrawItem->CtlID == kRamsgateButton) {
                    DrawDarkButton(DrawItem, ButtonFont);
                    return TRUE;
                }
                if (DrawItem->CtlID == kPrivateCheckbox) {
                    DrawDarkCheckbox(DrawItem, PrivateHuntChecked);
                    return TRUE;
                }
                if (DrawItem->CtlID == kDetailsPanel) {
                    DrawTrialDetails(DrawItem, CurrentDetails, UiFont, &ModifierHitRegions);
                    return TRUE;
                }
                if (DrawItem->CtlID == kDifficultyCombo || DrawItem->CtlID == kBehemothCombo || DrawItem->CtlID == kAtmosphereCombo) {
                    DrawComboItem(DrawItem, UiFont, DrawItem->CtlID == kBehemothCombo, DifficultyIndex(Hwnd));
                    return TRUE;
                }
                return 0;
            }

            case WM_COMMAND:
                if (LOWORD(WParam) == kPrivateCheckbox) {
                    PrivateHuntChecked = !PrivateHuntChecked;
                    InvalidateRect(GetDlgItem(Hwnd, kPrivateCheckbox), nullptr, TRUE);
                }
                else if (LOWORD(WParam) == kDifficultyCombo && HIWORD(WParam) == CBN_SELCHANGE) {
                    const std::wstring PreviousBehemoth = CurrentDetails.Behemoth;
                    PopulateTrialOptions(GetDlgItem(Hwnd, kBehemothCombo), DifficultyIndex(Hwnd), PreviousBehemoth);
                    UpdateTrialDetails(Hwnd);
                }
                else if (LOWORD(WParam) == kBehemothCombo && HIWORD(WParam) == CBN_SELCHANGE) {
                    UpdateTrialDetails(Hwnd);
                }
                else if (LOWORD(WParam) == kQueueButton) {
                    ApplyQueueUiUpdate(SubmitFindHunt(SelectedPlayerHuntId(Hwnd), PrivateHuntChecked));
                }
                else if (LOWORD(WParam) == kRamsgateButton) {
                    ApplyQueueUiUpdate(SubmitFindHunt(kRamsgatePlayerHuntId, true));
                }
                return 0;

            case WM_CLOSE:
                HideModifierTooltip();
                ShowWindow(Hwnd, SW_HIDE);
                return 0;

            case WM_DESTROY:
                DisableQueueUiUpdates();
                HideModifierTooltip();
                PostQuitMessage(0);
                return 0;

            default:
                return DefWindowProcW(Hwnd, Message, WParam, LParam);
            }
        }

        void UiThread() {
            // Force creation of the thread message queue before publishing its ID.
            MSG BootstrapMessage = {};
            PeekMessageW(&BootstrapMessage, nullptr, 0, 0, PM_NOREMOVE);

            INITCOMMONCONTROLSEX CommonControls = { sizeof(CommonControls), ICC_WIN95_CLASSES };
            InitCommonControlsEx(&CommonControls);

            WNDCLASSW WindowClass = {};
            WindowClass.lpfnWndProc = WindowProc;
            WindowClass.hInstance = GetModuleHandleW(nullptr);
            WindowClass.lpszClassName = L"UndauntedTrialsBrowserOverlay";
            WindowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
            const ATOM WindowClassAtom = RegisterClassW(&WindowClass);
            const bool OwnsWindowClass = WindowClassAtom != 0;
            if (!OwnsWindowClass && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
                DestroyResources();
                Started = false;
                return;
            }

            Window = CreateWindowExW(
                WS_EX_TOPMOST,
                WindowClass.lpszClassName,
                L"Undaunted Trials Browser",
                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                410,
                361,
                nullptr,
                nullptr,
                WindowClass.hInstance,
                nullptr
            );

            if (Window == nullptr) {
                if (OwnsWindowClass)
                    UnregisterClassW(WindowClass.lpszClassName, WindowClass.hInstance);
                DestroyResources();
                Started = false;
                return;
            }

            TitleIconSmall = CreateTransparentIcon(16);
            TitleIconBig = CreateTransparentIcon(32);
            SendMessageW(Window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(TitleIconSmall));
            SendMessageW(Window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(TitleIconBig));
            ShowWindow(Window, SW_HIDE);
            EnableQueueUiUpdates();

            MSG Message = {};
            while (GetMessageW(&Message, nullptr, 0, 0) > 0) {
                if (Message.hwnd == nullptr && Message.message == kToggleWindowMessage) {
                    ToggleWindow();
                    continue;
                }
                if (Message.hwnd == nullptr && Message.message == kApplyQueueUpdateMessage) {
                    if (const std::optional<QueueUiUpdate> Update = TakeQueueUiUpdate(); Update.has_value())
                        ApplyQueueUiUpdate(*Update);
                    continue;
                }
                TranslateMessage(&Message);
                DispatchMessageW(&Message);
            }

            DisableQueueUiUpdates();
            if (Window != nullptr && IsWindow(Window))
                DestroyWindow(Window);
            if (OwnsWindowClass)
                UnregisterClassW(WindowClass.lpszClassName, WindowClass.hInstance);
            DestroyResources();
            Started = false;
        }

        void LaunchUiThread() {
            bool Expected = false;
            if (!Started.compare_exchange_strong(Expected, true))
                return;

            try {
                std::thread(UiThread).detach();
            }
            catch (const std::system_error&) {
                Started = false;
            }
        }
    }

    void Start() {
        if (Globals::AmServer)
            return;

        // Start is called while the DLL is attaching. Launch from the first game tick instead.
        StartRequested = true;
    }

    void Tick(UObject* WorldContextObject) {
        if (Globals::AmServer)
            return;

        if (StartRequested.exchange(false))
            LaunchUiThread();

        static bool WasF7Down = false;
        const bool IsF7Down = (GetAsyncKeyState(VK_F7) & 0x8000) != 0;
        if (IsF7Down && !WasF7Down) {
            DWORD ForegroundProcessId = 0;
            GetWindowThreadProcessId(GetForegroundWindow(), &ForegroundProcessId);
            if (ForegroundProcessId == GetCurrentProcessId())
                PostUiThreadMessage(kToggleWindowMessage);
        }
        WasF7Down = IsF7Down;

        if (std::optional<QueueUiUpdate> Update = TickQueue(WorldContextObject); Update.has_value())
            PublishQueueUiUpdate(std::move(*Update));
    }
}
