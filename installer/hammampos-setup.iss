; HammamPOS Professional Installer Script
; Created with Inno Setup 6.x
; This script creates a professional Windows installer for HammamPOS

#define MyAppName "HammamPOS"
#define MyAppVersion "2.0.0"
#define MyAppPublisher "HammamPOS Solutions"
#define MyAppURL "https://hammampos.com"
#define MyAppExeName "HammamPOS.exe"
#define MyAppDescription "Professional Hammam & Spa Point of Sale System"

[Setup]
; NOTE: The value of AppId uniquely identifies this application.
; Do not use the same AppId value in installers for other applications.
AppId={{B8E5F8A0-1234-5678-9ABC-DEF012345678}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=..\LICENSE.txt
InfoBeforeFile=..\README.md
OutputDir=..\dist
OutputBaseFilename=HammamPOS-Setup-{#MyAppVersion}
SetupIconFile=..\resources\icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppDescription}
VersionInfoCopyright=Copyright (C) 2024 {#MyAppPublisher}
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "arabic"; MessagesFile: "compiler:Languages\Arabic.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "quicklaunchicon"; Description: "{cm:CreateQuickLaunchIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked; OnlyBelowVersion: 6.1
Name: "associate"; Description: "Associate .hammampos files with {#MyAppName}"; GroupDescription: "File associations:"

[Files]
; Main application files
Source: "..\dist\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Data directory structure
Source: "..\data\*"; DestDir: "{userappdata}\{#MyAppName}\data"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist
; Documentation
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
; License files
Source: "..\data\licenses\*"; DestDir: "{userappdata}\{#MyAppName}\licenses"; Flags: ignoreversion recursesubdirs createallsubdirs onlyifdoesntexist

[Registry]
; File associations
Root: HKCR; Subkey: ".hammampos"; ValueType: string; ValueName: ""; ValueData: "HammamPOSFile"; Flags: uninsdeletevalue; Tasks: associate
Root: HKCR; Subkey: "HammamPOSFile"; ValueType: string; ValueName: ""; ValueData: "{#MyAppName} Data File"; Flags: uninsdeletekey; Tasks: associate
Root: HKCR; Subkey: "HammamPOSFile\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Tasks: associate
Root: HKCR; Subkey: "HammamPOSFile\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Tasks: associate

; Application registration
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\{#MyAppExeName}"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\{#MyAppExeName}"; ValueType: string; ValueName: "Path"; ValueData: "{app}"; Flags: uninsdeletekey

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppDescription}"
Name: "{group}\{cm:ProgramOnTheWeb,{#MyAppName}}"; Filename: "{#MyAppURL}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppDescription}"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: quicklaunchicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\{#MyAppName}"

[Code]
var
  DataDirPage: TInputDirWizardPage;
  
procedure InitializeWizard;
begin
  // Create custom page for data directory selection
  DataDirPage := CreateInputDirPage(wpSelectDir,
    'Select Data Directory', 'Where should HammamPOS store its data?',
    'Select the folder in which HammamPOS should store its database and files, then click Next.',
    False, '');
  DataDirPage.Add('Data directory:');
  DataDirPage.Values[0] := ExpandConstant('{userappdata}\{#MyAppName}\data');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = DataDirPage.ID then
  begin
    if not DirExists(DataDirPage.Values[0]) then
    begin
      if not CreateDir(DataDirPage.Values[0]) then
      begin
        MsgBox('Unable to create data directory. Please select a different location.', mbError, MB_OK);
        Result := False;
      end;
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigFile: string;
  ConfigContent: TArrayOfString;
begin
  if CurStep = ssPostInstall then
  begin
    // Create configuration file with data directory path
    ConfigFile := ExpandConstant('{app}\config.json');
    SetArrayLength(ConfigContent, 3);
    ConfigContent[0] := '{';
    ConfigContent[1] := '  "dataPath": "' + StringChangeEx(DataDirPage.Values[0], '\', '\\', True) + '"';
    ConfigContent[2] := '}';
    SaveStringsToFile(ConfigFile, ConfigContent, False);
  end;
end;

function InitializeSetup(): Boolean;
var
  Version: TWindowsVersion;
  VersionString: String;
begin
  GetWindowsVersionEx(Version);
  
  // Check Windows version (Windows 7 or later recommended)
  if (Version.Major < 6) or ((Version.Major = 6) and (Version.Minor < 1)) then
  begin
    // Windows Vista or earlier
    MsgBox('HammamPOS requires Windows 7 or later. Your system (Windows ' + IntToStr(Version.Major) + '.' + IntToStr(Version.Minor) + ') is not supported.', mbCriticalError, MB_OK);
    Result := False;
  end
  else if (Version.Major = 6) and (Version.Minor = 1) then
  begin
    // Windows 7
    if MsgBox('You are running Windows 7. HammamPOS is optimized for Windows 10 or later. Some features may not work properly. Do you want to continue?', mbConfirmation, MB_YESNO) = IDYES then
      Result := True
    else
      Result := False;
  end
  else if (Version.Major = 6) and (Version.Minor >= 2) then
  begin
    // Windows 8/8.1
    if MsgBox('You are running Windows 8/8.1. HammamPOS is optimized for Windows 10 or later. Do you want to continue?', mbConfirmation, MB_YESNO) = IDYES then
      Result := True
    else
      Result := False;
  end
  else
    Result := True; // Windows 10 or later
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox('Do you want to remove all HammamPOS data files? This will permanently delete your business data.', mbConfirmation, MB_YESNO) = IDYES then
    begin
      DelTree(ExpandConstant('{userappdata}\{#MyAppName}'), True, True, True);
    end;
  end;
end;