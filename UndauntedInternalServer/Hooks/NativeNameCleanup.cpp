#include "NativeNameCleanup.h"

#include <cwchar>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <Windows.h>

#include "../SDK.hpp"

namespace Globals {
    extern bool AmServer;
    extern uintptr_t BaseAddress;
    extern bool EnableLogging;
    extern std::wstring MetagameAddress;
}

namespace {
    bool DidPatchNativeNoEpicFormat = false;
    bool DidLogNativeNoEpicFormatPatch = false;

    bool IsEnabled() {
        return !Globals::AmServer && !Globals::MetagameAddress.empty();
    }

    void Log(const std::string& Message) {
        if (Globals::EnableLogging && IsEnabled()) {
            std::cout << "[NATIVE-NAME] " << Message << std::endl;
        }
    }

    std::string HexAddress(uintptr_t Address) {
        std::ostringstream Stream;
        Stream << "0x" << std::uppercase << std::hex << Address;
        return Stream.str();
    }

    std::string HexBytes(uintptr_t Address, size_t Length) {
        const auto* Bytes = reinterpret_cast<const unsigned char*>(Address);
        std::ostringstream Stream;
        Stream << std::uppercase << std::hex << std::setfill('0');
        for (size_t Index = 0; Index < Length; ++Index) {
            if (Index > 0) {
                Stream << ' ';
            }
            Stream << std::setw(2) << static_cast<int>(Bytes[Index]);
        }

        return Stream.str();
    }

    std::string WidePreview(const wchar_t* Text, size_t MaxChars) {
        if (!Text) {
            return "<null>";
        }

        std::wstring Wide;
        for (size_t Index = 0; Index < MaxChars && Text[Index] != L'\0'; ++Index) {
            Wide.push_back(Text[Index]);
        }

        return SDK::FString(Wide.c_str()).ToString();
    }

    void PatchNativeNoEpicAccountFormatString() {
        if (DidPatchNativeNoEpicFormat || !Globals::BaseAddress) {
            return;
        }

        // TODO: Find out location of FUN_1409c1ce0 persistent across game versions
        // FUN_1409c1ce0 adds [No Epic Account] to local users. We null suffix to L"%s".
        constexpr uintptr_t kNoEpicAccountFunctionRva = 0x9C1CE0;
        constexpr uintptr_t kNoEpicAccountFunctionEndRva = 0x9C20E8;
        constexpr uintptr_t kNoEpicAccountXrefRva = 0x9C2006;
        constexpr uintptr_t kNoEpicAccountCallsiteSignatureRva = 0x9C1FFA;
        constexpr uintptr_t kNoEpicAccountFormatStringRva = 0x441F218;
        constexpr size_t kFunctionEntrySignatureLength = 64;
        constexpr size_t kCallsiteSignatureLength = 24;

        const uintptr_t FunctionAddress = Globals::BaseAddress + kNoEpicAccountFunctionRva;
        const uintptr_t FunctionEndAddress = Globals::BaseAddress + kNoEpicAccountFunctionEndRva;
        const uintptr_t XrefAddress = Globals::BaseAddress + kNoEpicAccountXrefRva;
        const uintptr_t CallsiteSignatureAddress = Globals::BaseAddress + kNoEpicAccountCallsiteSignatureRva;
        const uintptr_t FormatStringAddress = Globals::BaseAddress + kNoEpicAccountFormatStringRva;
        wchar_t* FormatString = reinterpret_cast<wchar_t*>(FormatStringAddress);

        const std::string IdentifierLog = "identifier=FUN_1409c1ce0"
            " functionRva=0x9C1CE0"
            " functionVa=" + HexAddress(FunctionAddress)
            + " functionEndRva=0x9C20E8"
            + " functionEndVa=" + HexAddress(FunctionEndAddress)
            + " formatStringRva=0x441F218"
            + " formatStringVa=" + HexAddress(FormatStringAddress)
            + " xrefRva=0x9C2006"
            + " xrefVa=" + HexAddress(XrefAddress)
            + " entrySig=" + HexBytes(FunctionAddress, kFunctionEntrySignatureLength)
            + " callsiteSigRva=0x9C1FFA"
            + " callsiteSig=" + HexBytes(CallsiteSignatureAddress, kCallsiteSignatureLength);

        if (std::wcsncmp(FormatString, L"%s [No Epic Account]", 20) != 0) {
            if (!DidLogNativeNoEpicFormatPatch) {
                DidLogNativeNoEpicFormatPatch = true;
                Log("native [No Epic Account] format string mismatch; found=\""
                    + WidePreview(FormatString, 48) + "\" " + IdentifierLog);
            }
            return;
        }

        DWORD OldProtect = 0;
        if (!VirtualProtect(&FormatString[2], sizeof(wchar_t), PAGE_READWRITE, &OldProtect)) {
            if (!DidLogNativeNoEpicFormatPatch) {
                DidLogNativeNoEpicFormatPatch = true;
                Log("failed to make native [No Epic Account] format string writable; "
                    + IdentifierLog);
            }
            return;
        }

        FormatString[2] = L'\0';
        VirtualProtect(&FormatString[2], sizeof(wchar_t), OldProtect, &OldProtect);
        DidPatchNativeNoEpicFormat = true;
        if (!DidLogNativeNoEpicFormatPatch) {
            DidLogNativeNoEpicFormatPatch = true;
            Log("patched native [No Epic Account] format string to L\"%s\"; "
                + IdentifierLog);
        }
    }
}

namespace NativeNameCleanup {
    void Init() {
        if (!IsEnabled()) {
            return;
        }

        PatchNativeNoEpicAccountFormatString();
    }
}
